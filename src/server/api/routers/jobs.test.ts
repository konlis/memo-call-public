import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";

// `~/server/api/trpc` imports `~/server/auth` (NextAuth), whose `next/server`
// import is unresolvable in vitest's node env. We build ctx by hand and never
// call the real `createTRPCContext`, so stub the only thing trpc.ts pulls from
// auth — the `auth()` resolver — to keep NextAuth out of the test graph.
vi.mock("~/server/auth", () => ({ auth: async () => null }));

import { createJobsRouter } from "~/server/api/routers/jobs";
import { createCallerFactory, type createTRPCContext } from "~/server/api/trpc";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import { conversations, processingJobs, users } from "~/server/db/schema";

// Real-libsql integration test: the router's UPDATE … WHERE (status='failed' AND
// user_id=?) RETURNING and the findMany scoping are real SQL a stub can't prove.
const DB_PATH = makeIntegrationDbPath("jobs-router");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

type Ctx = Awaited<ReturnType<typeof createTRPCContext>>;

/** Build a tRPC ctx; `authed=false` yields a null session (UNAUTHORIZED path). */
function makeCtx(authed: boolean): Ctx {
	return {
		db,
		headers: new Headers(),
		userId: "me" as const,
		session: authed
			? { user: { id: "me" }, expires: "2099-01-01T00:00:00.000Z" }
			: null,
	} as unknown as Ctx;
}

/**
 * Replay spy so we assert the kickoff side effect without running the worker.
 * `calls` records the job ids; `kinds` records which pipeline the router asked
 * for — the seam that decides `processJob` vs `reanalyzeJob` in production.
 */
function makeRouterWithSpy() {
	const calls: string[] = [];
	const kinds: string[] = [];
	const router = createJobsRouter({
		onReplay: (jobId, _db, kind) => {
			calls.push(jobId);
			kinds.push(kind);
		},
	});
	const caller = (ctx: Ctx) => createCallerFactory(router)(ctx);
	return { caller, calls, kinds };
}

let seq = 0;
async function seedJob(opts: {
	userId: string;
	status: string;
	updatedAt?: Date;
	/**
	 * Job kind. Omitted from the INSERT when not supplied, so every pre-existing
	 * call site keeps taking the column default (`'analyze'`) byte-identically.
	 */
	kind?: string;
}): Promise<string> {
	seq += 1;
	const conversationId = `c-${seq}`;
	const jobId = `j-${seq}`;
	await db
		.insert(conversations)
		.values({ id: conversationId, userId: opts.userId, callSid: `CA_${seq}` });
	await db.insert(processingJobs).values({
		id: jobId,
		userId: opts.userId,
		conversationId,
		status: opts.status,
		attemptCount: 3,
		lastError: "boom",
		lastErrorCode: "transport",
		...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
		...(opts.kind ? { kind: opts.kind } : {}),
	});
	return jobId;
}

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
	// A second user so we can prove user-scoping (the migration seeds only 'me').
	await db.insert(users).values({ id: "other" });
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_processing_jobs"');
	await client.execute('DELETE FROM "memo-call_conversations"');
});

async function jobRow(jobId: string) {
	const r = await client.execute({
		sql: 'SELECT status, attempt_count, next_retry_at, last_error, last_error_code FROM "memo-call_processing_jobs" WHERE id = ?',
		args: [jobId],
	});
	return r.rows[0];
}

describe("jobs.listFailed", () => {
	test("returns only the current user's failed jobs, newest first", async () => {
		const older = await seedJob({
			userId: "me",
			status: "failed",
			updatedAt: new Date("2026-06-10T10:00:00.000Z"),
		});
		const newer = await seedJob({
			userId: "me",
			status: "failed",
			updatedAt: new Date("2026-06-10T11:00:00.000Z"),
		});
		await seedJob({ userId: "me", status: "done" }); // excluded — not failed
		await seedJob({ userId: "other", status: "failed" }); // excluded — other user

		const { caller } = makeRouterWithSpy();
		const rows = await caller(makeCtx(true)).listFailed();

		expect(rows.map((r) => r.id)).toEqual([newer, older]);
		expect(rows.every((r) => r.status === "failed")).toBe(true);
		expect(rows.every((r) => r.userId === "me")).toBe(true);
	});

	test("returns an empty list when there are no failed jobs", async () => {
		await seedJob({ userId: "me", status: "done" });
		const { caller } = makeRouterWithSpy();
		expect(await caller(makeCtx(true)).listFailed()).toEqual([]);
	});
});

describe("jobs.replay", () => {
	test("resets a failed job to pending and invokes the kickoff", async () => {
		const jobId = await seedJob({ userId: "me", status: "failed" });
		const { caller, calls } = makeRouterWithSpy();

		const res = await caller(makeCtx(true)).replay({ jobId });
		expect(res).toEqual({ ok: true });

		const row = await jobRow(jobId);
		expect(row?.status).toBe("pending");
		expect(Number(row?.attempt_count)).toBe(0);
		expect(row?.next_retry_at).toBeNull();
		expect(row?.last_error).toBeNull();
		expect(row?.last_error_code).toBeNull();
		expect(calls).toEqual([jobId]); // kickoff fired exactly once
	});

	test("propagates kind='reanalyze' to the kickoff seam (never the audio-first path)", async () => {
		// `replay` is the ONLY caller that hands a job id to a worker without knowing
		// which pipeline owns it. If it always started the audio-first worker, replaying
		// a failed re-analyze would re-transcribe deleted audio and clobber the user's
		// edited transcript + user-edited tags. The kind read from the reset row is the
		// seam that routes it — assert it reaches the injected side effect verbatim.
		const jobId = await seedJob({
			userId: "me",
			status: "failed",
			kind: "reanalyze",
		});
		const { caller, calls, kinds } = makeRouterWithSpy();

		await caller(makeCtx(true)).replay({ jobId });

		expect(calls).toEqual([jobId]);
		expect(kinds).toEqual(["reanalyze"]);
	});

	test("propagates kind='analyze' for a default-kind (first-run) job", async () => {
		// Complement: a job seeded without an explicit kind takes the column default,
		// and replay must still start the audio-first pipeline.
		const jobId = await seedJob({ userId: "me", status: "failed" });
		const { caller, kinds } = makeRouterWithSpy();

		await caller(makeCtx(true)).replay({ jobId });

		expect(kinds).toEqual(["analyze"]);
	});

	test("a non-failed job is NOT_FOUND and does not kick off", async () => {
		const jobId = await seedJob({ userId: "me", status: "done" });
		const { caller, calls } = makeRouterWithSpy();

		await expect(caller(makeCtx(true)).replay({ jobId })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);
		expect(calls).toEqual([]);
	});

	test("another user's failed job is NOT_FOUND (user-scoped)", async () => {
		const jobId = await seedJob({ userId: "other", status: "failed" });
		const { caller, calls } = makeRouterWithSpy();

		await expect(caller(makeCtx(true)).replay({ jobId })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);
		expect(calls).toEqual([]);
		// The other user's row is untouched.
		expect((await jobRow(jobId))?.status).toBe("failed");
	});
});

describe("requireSession gate", () => {
	test("listFailed rejects an unauthenticated caller", async () => {
		const { caller } = makeRouterWithSpy();
		await expect(caller(makeCtx(false)).listFailed()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	test("replay rejects an unauthenticated caller", async () => {
		const jobId = await seedJob({ userId: "me", status: "failed" });
		const { caller, calls } = makeRouterWithSpy();
		await expect(
			caller(makeCtx(false)).replay({ jobId }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(calls).toEqual([]);
	});
});
