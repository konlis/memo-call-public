import { type Client, createClient } from "@libsql/client";
import { inArray } from "drizzle-orm";
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

import { projectsRouter } from "~/server/api/routers/projects";
import { createCallerFactory, type createTRPCContext } from "~/server/api/trpc";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import {
	conversations,
	processingJobs,
	projects,
	tags,
	users,
} from "~/server/db/schema";
import { createProjectInput } from "~/server/projects/schema";
import { telephony } from "~/server/telephony";

// Real-libsql integration harness (mirrors jobs.test.ts): the app-layer
// uniqueness check + insert is real SQL a stub can't prove. Covers create /
// list-count / delete-cascade / scoping describes against the same DB.
const DB_PATH = makeIntegrationDbPath("projects-router");
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

const caller = (ctx: Ctx) => createCallerFactory(projectsRouter)(ctx);

// Direct seeders (bypass the caller) so a test controls the owning user + the
// project_id assignment — the caller's `create` only ever writes `ctx.userId`,
// and we need 'other'-owned rows to prove user-scoping.
let pseq = 0;
async function seedProject(opts: {
	userId: string;
	name: string;
	category: string;
}): Promise<string> {
	pseq += 1;
	const id = `p-${pseq}`;
	await db.insert(projects).values({
		id,
		userId: opts.userId,
		name: opts.name,
		category: opts.category,
	});
	return id;
}

let cseq = 0;
async function seedConversation(opts: {
	userId: string;
	projectId?: string;
	// Optional recording fields so the FR-002 cleanup tests can seed a resident
	// (recordingSid set, recordingDeletedAt null) or already-cleared recording.
	recordingSid?: string;
	recordingDeletedAt?: Date | null;
}): Promise<string> {
	cseq += 1;
	const id = `c-${cseq}`;
	await db.insert(conversations).values({
		id,
		userId: opts.userId,
		callSid: `CA_${cseq}`,
		...(opts.projectId ? { projectId: opts.projectId } : {}),
		...(opts.recordingSid ? { recordingSid: opts.recordingSid } : {}),
		...(opts.recordingDeletedAt !== undefined
			? { recordingDeletedAt: opts.recordingDeletedAt }
			: {}),
	});
	return id;
}

/** Seed a `tags` row (a conversation dependent that cascades off conversations.id). */
async function seedTag(conversationId: string): Promise<string> {
	const id = `t-${conversationId}`;
	await db.insert(tags).values({
		id,
		userId: "me",
		conversationId,
		name: "klient",
	});
	return id;
}

/** Seed a `processing_jobs` row (a conversation dependent that cascades off conversations.id). */
async function seedJob(conversationId: string): Promise<string> {
	const id = `j-${conversationId}`;
	await db.insert(processingJobs).values({
		id,
		userId: "me",
		conversationId,
	});
	return id;
}

/** Whether a conversation row still exists (cascade target). */
async function convExists(id: string): Promise<boolean> {
	const r = await client.execute({
		sql: 'SELECT 1 FROM "memo-call_conversations" WHERE id = ?',
		args: [id],
	});
	return r.rows.length > 0;
}

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
	// A second user so Phase 2 can prove user-scoping (the migration seeds only 'me').
	await db.insert(users).values({ id: "other" });
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_reconcile_tombstones"');
	await client.execute('DELETE FROM "memo-call_conversations"');
	await client.execute('DELETE FROM "memo-call_projects"');
});

// --- Pure-schema validation oracle (no DB): the createProjectInput contract. ---
describe("createProjectInput schema", () => {
	test("accepts a 60-char name", () => {
		expect(
			createProjectInput.safeParse({ name: "a".repeat(60), category: "praca" })
				.success,
		).toBe(true);
	});

	test("rejects a 61-char name", () => {
		expect(
			createProjectInput.safeParse({ name: "a".repeat(61), category: "praca" })
				.success,
		).toBe(false);
	});

	test("rejects empty and whitespace-only names", () => {
		expect(
			createProjectInput.safeParse({ name: "", category: "praca" }).success,
		).toBe(false);
		expect(
			createProjectInput.safeParse({ name: "   ", category: "praca" }).success,
		).toBe(false);
	});

	test("trims the name before the length check (parsed value is trimmed)", () => {
		const r = createProjectInput.safeParse({
			name: "  Klient X  ",
			category: "praca",
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.name).toBe("Klient X");
	});

	test("a name that is ≤60 only after trim is accepted", () => {
		expect(
			createProjectInput.safeParse({
				name: `  ${"a".repeat(60)}  `,
				category: "praca",
			}).success,
		).toBe(true);
	});

	test("rejects a category outside praca/prywatne", () => {
		expect(
			createProjectInput.safeParse({ name: "X", category: "foo" }).success,
		).toBe(false);
	});

	test("accepts both valid categories", () => {
		expect(
			createProjectInput.safeParse({ name: "X", category: "praca" }).success,
		).toBe(true);
		expect(
			createProjectInput.safeParse({ name: "X", category: "prywatne" }).success,
		).toBe(true);
	});
});

// --- create path (real DB): app-layer case-insensitive uniqueness within category. ---
describe("projects.create", () => {
	test("inserts a project and returns it", async () => {
		const row = await caller(makeCtx(true)).create({
			name: "Klient X",
			category: "praca",
		});
		expect(row?.name).toBe("Klient X");
		expect(row?.category).toBe("praca");
		expect(row?.id).toBeTruthy();
	});

	test("rejects a case-insensitive duplicate within the same category (CONFLICT)", async () => {
		await caller(makeCtx(true)).create({ name: "Klient X", category: "praca" });
		await expect(
			caller(makeCtx(true)).create({ name: "klient x", category: "praca" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	test("trims before the uniqueness check (collides despite surrounding whitespace)", async () => {
		await caller(makeCtx(true)).create({ name: "Klient X", category: "praca" });
		await expect(
			caller(makeCtx(true)).create({ name: "  klient x  ", category: "praca" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	test("allows the same name in the other category", async () => {
		await caller(makeCtx(true)).create({ name: "Klient X", category: "praca" });
		const row = await caller(makeCtx(true)).create({
			name: "Klient X",
			category: "prywatne",
		});
		expect(row?.category).toBe("prywatne");
	});
});

// --- list path (real DB): the LEFT-JOIN + GROUP-BY count a stub would lie about. ---
describe("projects.list", () => {
	test("counts assigned conversations per project; a zero-conversation project is still listed with 0, across both groups", async () => {
		const work = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		await seedConversation({ userId: "me", projectId: work });
		await seedConversation({ userId: "me", projectId: work });
		// A genuinely empty project in the OTHER category — proves LEFT JOIN keeps
		// the no-match row (count 0) AND that both groups surface even when one is empty.
		await seedProject({ userId: "me", name: "Dom", category: "prywatne" });

		const rows = await caller(makeCtx(true)).list();

		const byName = new Map(rows.map((r) => [r.name, r]));
		expect(byName.get("Klient X")?.conversationCount).toBe(2);
		expect(byName.get("Dom")?.conversationCount).toBe(0);
		// Ordered (category, name): praca before prywatne.
		expect(rows.map((r) => r.category)).toEqual(["praca", "prywatne"]);
		// count() must come back as a JS number (mapWith(Number)), not a string.
		expect(typeof byName.get("Dom")?.conversationCount).toBe("number");
	});

	test("does not count another user's conversation pointing at a 'me' project (JOIN-ON user-scope), and the project still returns 0", async () => {
		// 'other' user owns a conversation whose project_id points at a 'me' project.
		// The FK does not enforce same-user, so without the user predicate in the
		// JOIN ON this would be miscounted as 1 — and if that predicate were in the
		// WHERE instead, the LEFT JOIN would turn INNER and the project would vanish.
		const mine = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		await seedConversation({ userId: "other", projectId: mine });

		const rows = await caller(makeCtx(true)).list();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Klient X");
		expect(rows[0]?.conversationCount).toBe(0);
	});

	test("returns only the current user's projects", async () => {
		await seedProject({ userId: "me", name: "Mine", category: "praca" });
		await seedProject({ userId: "other", name: "Theirs", category: "praca" });

		const rows = await caller(makeCtx(true)).list();

		expect(rows.map((r) => r.name)).toEqual(["Mine"]);
	});
});

// --- delete path (real DB): HARD cascade — deleting a project removes its
// conversations (and their dependents via the conversations.id cascade) after
// best-effort-deleting any resident recording first (FR-002). The cascade +
// dependent removal are exactly what a stub would lie about. ---
describe("projects.delete", () => {
	test("hard-deletes assigned conversations (cascade, not orphan)", async () => {
		const proj = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		const convA = await seedConversation({ userId: "me", projectId: proj });
		const convB = await seedConversation({ userId: "me", projectId: proj });

		const res = await caller(makeCtx(true)).delete({ id: proj });
		expect(res).toEqual({ ok: true });

		// The conversation rows are GONE (hard cascade), not nulled.
		expect(await convExists(convA)).toBe(false);
		expect(await convExists(convB)).toBe(false);
		// And the project is gone from the list.
		expect((await caller(makeCtx(true)).list()).map((r) => r.id)).not.toContain(
			proj,
		);
	});

	test("only deletes the target project's conversations, not a sibling project's", async () => {
		const target = await seedProject({
			userId: "me",
			name: "Target",
			category: "praca",
		});
		const keep = await seedProject({
			userId: "me",
			name: "Keep",
			category: "praca",
		});
		const doomed = await seedConversation({ userId: "me", projectId: target });
		const survivor = await seedConversation({ userId: "me", projectId: keep });

		await caller(makeCtx(true)).delete({ id: target });

		expect(await convExists(doomed)).toBe(false);
		expect(await convExists(survivor)).toBe(true);
	});

	test("cascades to conversation dependents (tag + processing job removed)", async () => {
		const proj = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		const conv = await seedConversation({ userId: "me", projectId: proj });
		await seedTag(conv);
		await seedJob(conv);

		await caller(makeCtx(true)).delete({ id: proj });

		// Dependents cascade off conversations.id (PRAGMA foreign_keys = ON).
		const tagRows = await client.execute({
			sql: 'SELECT 1 FROM "memo-call_tags" WHERE conversation_id = ?',
			args: [conv],
		});
		const jobRows = await client.execute({
			sql: 'SELECT 1 FROM "memo-call_processing_jobs" WHERE conversation_id = ?',
			args: [conv],
		});
		expect(tagRows.rows).toHaveLength(0);
		expect(jobRows.rows).toHaveLength(0);
	});

	test("best-effort-deletes a resident recording before the rows (FR-002 guard)", async () => {
		// recordingSid set + recordingDeletedAt NULL ⇒ a recording is still resident,
		// so the cleanup branch must fire. The mock's deleteRecording is a no-op, so
		// without this spy nothing would catch a dropped call or an inverted guard.
		const proj = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		await seedConversation({
			userId: "me",
			projectId: proj,
			recordingSid: "RE-resident",
			recordingDeletedAt: null,
		});
		const spy = vi.spyOn(telephony, "deleteRecording");

		try {
			await caller(makeCtx(true)).delete({ id: proj });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith({ recordingSid: "RE-resident" });
		} finally {
			spy.mockRestore();
		}
	});

	/**
	 * Full-review F2. The phase-2 F1 fix landed in BOTH delete paths, but only
	 * `conversations.delete` got a test — removing the `tombstoneCallSids` call
	 * from `projects.ts` left the whole suite green. This is the bulk path: it
	 * buries every conversation of a project at once, so an unguarded regression
	 * here resurrects a whole project's notes and re-bills Deepgram + Bedrock for
	 * all of them.
	 */
	test("buries the call_sid of EVERY conversation in the cascade", async () => {
		const proj = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		const a = await seedConversation({ userId: "me", projectId: proj });
		const b = await seedConversation({ userId: "me", projectId: proj });
		// Read the generated call_sids back rather than reconstructing them — the
		// seed helper's numbering is shared across this file and drifts with test
		// order.
		const seeded = await db
			.select({ callSid: conversations.callSid })
			.from(conversations)
			.where(inArray(conversations.id, [a, b]));
		const expected = seeded.map((r) => r.callSid).sort();
		expect(expected).toHaveLength(2);

		await caller(makeCtx(true)).delete({ id: proj });

		const buried = await client.execute(
			'SELECT user_id, call_sid FROM "memo-call_reconcile_tombstones"',
		);
		expect(buried.rows.map((r) => r.call_sid).sort()).toEqual(expected);
		expect(buried.rows.every((r) => r.user_id === "me")).toBe(true);
	});

	test("does NOT re-delete a recording already cleared (recordingDeletedAt set)", async () => {
		const proj = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		await seedConversation({
			userId: "me",
			projectId: proj,
			recordingSid: "RE-gone",
			recordingDeletedAt: new Date("2026-06-10T10:06:00.000Z"),
		});
		const spy = vi.spyOn(telephony, "deleteRecording");

		try {
			await caller(makeCtx(true)).delete({ id: proj });
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	test("a failing recording cleanup does NOT abort the cascade (best-effort)", async () => {
		// The mock's deleteRecording is a no-op, so the catch branch is otherwise
		// never exercised — stub a rejection to prove a provider failure is logged
		// but non-fatal: the conversations still delete and the call still resolves.
		const proj = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		const conv = await seedConversation({
			userId: "me",
			projectId: proj,
			recordingSid: "RE-boom",
			recordingDeletedAt: null,
		});
		const spy = vi
			.spyOn(telephony, "deleteRecording")
			.mockRejectedValue(new Error("provider 500"));

		try {
			const res = await caller(makeCtx(true)).delete({ id: proj });
			expect(res).toEqual({ ok: true });
			// The cascade completed despite the provider error.
			expect(await convExists(conv)).toBe(false);
			expect(
				(await caller(makeCtx(true)).list()).map((r) => r.id),
			).not.toContain(proj);
		} finally {
			spy.mockRestore();
		}
	});

	test("deleting another user's project id → NOT_FOUND, leaving their rows untouched", async () => {
		const theirs = await seedProject({
			userId: "other",
			name: "Theirs",
			category: "praca",
		});
		const theirConv = await seedConversation({
			userId: "other",
			projectId: theirs,
		});

		await expect(
			caller(makeCtx(true)).delete({ id: theirs }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// The other user's project AND its conversation survive (no cross-user delete).
		const r = await client.execute({
			sql: 'SELECT id FROM "memo-call_projects" WHERE id = ?',
			args: [theirs],
		});
		expect(r.rows).toHaveLength(1);
		expect(await convExists(theirConv)).toBe(true);
	});

	test("deleting a non-existent id → NOT_FOUND (not 500)", async () => {
		await expect(
			caller(makeCtx(true)).delete({ id: "does-not-exist" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

// --- requireSession gate: every procedure rejects an unauthenticated caller. ---
describe("requireSession gate", () => {
	test("create rejects an unauthenticated caller", async () => {
		await expect(
			caller(makeCtx(false)).create({ name: "X", category: "praca" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("list rejects an unauthenticated caller", async () => {
		await expect(caller(makeCtx(false)).list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	test("delete rejects an unauthenticated caller", async () => {
		await expect(
			caller(makeCtx(false)).delete({ id: "whatever" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
