import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	afterAll,
	afterEach,
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

import { ProviderError } from "~/server/_lib/provider-error";
import { callsRouter } from "~/server/api/routers/calls";
import { createCallerFactory, type createTRPCContext } from "~/server/api/trpc";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import { users } from "~/server/db/schema";
import { telephony } from "~/server/telephony";

// Real-libsql integration harness (mirrors projects.test.ts / jobs.test.ts).
// `placeOutbound` now upserts into `dialed_numbers` through a real ON CONFLICT
// clause, and lessons.md is explicit that a stub db cannot prove that SQL: the
// partial-index `onConflictDoNothing({ target, where })` bug shipped a 500 to
// production with every stub test green. So this file runs the real migrations.
const DB_PATH = makeIntegrationDbPath("calls-router");
const DB_URL = `file:${DB_PATH}`;

// The expected callback URL is derived from vitest.config.ts's PUBLIC_BASE_URL.
const EXPECTED_CALLBACK =
	"https://test.memo-call.example/api/telephony/recording-status";

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

type Ctx = Awaited<ReturnType<typeof createTRPCContext>>;

function makeCtx(authed: boolean, userId = "me"): Ctx {
	return {
		db,
		headers: new Headers(),
		userId,
		session: authed
			? { user: { id: userId }, expires: "2099-01-01T00:00:00.000Z" }
			: null,
	} as unknown as Ctx;
}

function caller(ctx: Ctx) {
	return createCallerFactory(callsRouter)(ctx);
}

/** Raw row read — asserts against physical columns, not the router's shape. */
async function historyRows(userId = "me") {
	const r = await client.execute({
		sql: `SELECT id, e164, last_used_at FROM "memo-call_dialed_numbers" WHERE user_id = ? ORDER BY last_used_at DESC`,
		args: [userId],
	});
	return r.rows as unknown as Array<{
		id: string;
		e164: string;
		last_used_at: number;
	}>;
}

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
	// A second user so the scoping tests are real (the migration seeds only 'me').
	await db.insert(users).values({ id: "other" });
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_dialed_numbers"');
	// `history` LEFT JOINs contacts by value since `contact-directory` phase 3,
	// so a leftover contact would sign a later test's number.
	await client.execute('DELETE FROM "memo-call_contacts"');
});

/** Raw contact insert — the router under test here is `calls`, not `contacts`. */
async function seedContact(
	id: string,
	userId: string,
	name: string,
	e164: string | null,
) {
	await client.execute({
		sql: `INSERT INTO "memo-call_contacts" (id, user_id, name, e164) VALUES (?,?,?,?)`,
		args: [id, userId, name, e164],
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("calls.placeOutbound", () => {
	test("normalizes the number and passes the absolute callback URL to placeCall", async () => {
		const spy = vi
			.spyOn(telephony, "placeCall")
			.mockResolvedValue({ callSid: "CA-stub-1" });

		// A messy national-format input; the router must normalize before placing.
		const res = await caller(makeCtx(true)).placeOutbound({
			to: "600 100 200",
		});

		expect(res).toEqual({ ok: true, callSid: "CA-stub-1" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({
			to: "+48600100200",
			recordingStatusCallbackUrl: EXPECTED_CALLBACK,
		});
	});

	test("rejects an invalid number with BAD_REQUEST and never calls the provider", async () => {
		const spy = vi.spyOn(telephony, "placeCall");

		await expect(
			caller(makeCtx(true)).placeOutbound({ to: "not-a-number" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(spy).not.toHaveBeenCalled();
		// A rejected number must not leave a trace in the history either.
		expect(await historyRows()).toHaveLength(0);
	});

	test("maps a ProviderError to a generic INTERNAL_SERVER_ERROR (no vendor detail leaked)", async () => {
		vi.spyOn(telephony, "placeCall").mockRejectedValue(
			new ProviderError({
				code: "auth",
				message: "twilio outbound requires TWILIO_CALLER_ID",
			}),
		);

		const promise = caller(makeCtx(true)).placeOutbound({ to: "+48600100200" });
		await expect(promise).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
		// The client-facing message must NOT carry the provider's precise reason.
		await expect(promise).rejects.toThrow("Could not place the call");
		await expect(promise).rejects.not.toThrow(/TWILIO_CALLER_ID/);
	});

	test("a failed call writes no history entry", async () => {
		vi.spyOn(telephony, "placeCall").mockRejectedValue(
			new ProviderError({ code: "transport", message: "boom" }),
		);

		await expect(
			caller(makeCtx(true)).placeOutbound({ to: "+48600100200" }),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(await historyRows()).toHaveLength(0);
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		const spy = vi.spyOn(telephony, "placeCall");

		await expect(
			caller(makeCtx(false)).placeOutbound({ to: "+48600100200" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("calls.placeOutbound — dialing history (real ON CONFLICT)", () => {
	test("a placed call records the E.164 number", async () => {
		vi.spyOn(telephony, "placeCall").mockResolvedValue({ callSid: "CA-1" });

		await caller(makeCtx(true)).placeOutbound({ to: "600 100 200" });

		const rows = await historyRows();
		expect(rows).toHaveLength(1);
		// Stored normalized, not as typed — that is what makes the dedupe below work.
		expect(rows[0]?.e164).toBe("+48600100200");
	});

	test("re-dialing the same number UPDATES one row instead of appending (the ON CONFLICT path)", async () => {
		vi.spyOn(telephony, "placeCall").mockResolvedValue({ callSid: "CA-2" });

		// Seed the row with a deliberately old timestamp so the bump is observable
		// without depending on wall-clock granularity between two rapid dials.
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?)`,
			args: ["seeded", "me", "+48600100200", 1000],
		});

		await caller(makeCtx(true)).placeOutbound({ to: "+48600100200" });

		const rows = await historyRows();
		expect(rows).toHaveLength(1);
		// Same row (id preserved) — an append would have produced a second id.
		expect(rows[0]?.id).toBe("seeded");
		expect(rows[0]?.last_used_at).toBeGreaterThan(1000);
	});

	test("differently-typed forms of one number collapse to a single row", async () => {
		vi.spyOn(telephony, "placeCall").mockResolvedValue({ callSid: "CA-3" });

		const c = caller(makeCtx(true));
		await c.placeOutbound({ to: "600 100 200" });
		await c.placeOutbound({ to: "+48 600 100 200" });
		await c.placeOutbound({ to: "+48600100200" });

		expect(await historyRows()).toHaveLength(1);
	});

	test("a history-write failure does NOT fail an already-placed call", async () => {
		vi.spyOn(telephony, "placeCall").mockResolvedValue({ callSid: "CA-4" });
		const broken = makeCtx(true);
		// The call is placed before the history write; a DB fault at that point must
		// not be reported to the user as a failed call.
		vi.spyOn(broken.db, "insert").mockImplementation(() => {
			throw new Error("db gone");
		});

		await expect(
			caller(broken).placeOutbound({ to: "+48600100200" }),
		).resolves.toEqual({ ok: true, callSid: "CA-4" });
	});

	test("a REAL history-write failure logs `call.history_write_failed` WITHOUT the dialled number", async () => {
		// caller-identity-in-archive phase 2 (FR-025). drizzle-orm wraps a failed
		// statement in `DrizzleQueryError`, whose message ends in
		// `params: <bound values>` — for this INSERT that is the dialled number.
		// Before the sanitizer, the audit line printed it verbatim. A stubbed
		// `insert` (the test above) throws a plain Error and cannot show this;
		// only a real failing statement produces the real message shape.
		vi.spyOn(telephony, "placeCall").mockResolvedValue({ callSid: "CA-5" });
		const lines: string[] = [];
		const stderr = vi
			.spyOn(console, "error")
			.mockImplementation((line: unknown) => {
				lines.push(String(line));
			});

		// Take the table away so the real INSERT fails at libsql, then restore it
		// so the suite's `beforeEach` DELETE keeps working.
		await client.execute(
			'ALTER TABLE "memo-call_dialed_numbers" RENAME TO "memo-call_dialed_numbers__hidden"',
		);
		try {
			// Positive control first: the raw error really does carry the number.
			const raw = await db
				.insert(schema.dialedNumbers)
				.values({ id: "probe", userId: "me", e164: "+48600100200" })
				.then(
					() => null,
					(e: unknown) => e as Error,
				);
			expect(raw?.message).toContain("params:");
			expect(raw?.message).toContain("+48600100200");

			await expect(
				caller(makeCtx(true)).placeOutbound({ to: "+48600100200" }),
			).resolves.toEqual({ ok: true, callSid: "CA-5" });
		} finally {
			await client.execute(
				'ALTER TABLE "memo-call_dialed_numbers__hidden" RENAME TO "memo-call_dialed_numbers"',
			);
			stderr.mockRestore();
		}

		const failed = lines
			.map((l) => {
				try {
					return JSON.parse(l) as { event?: string; error?: string };
				} catch {
					return null;
				}
			})
			.filter((e) => e?.event === "call.history_write_failed");
		expect(failed).toHaveLength(1);
		const error = failed[0]?.error ?? "";
		expect(error.length).toBeGreaterThan(0);
		expect(error).not.toContain("600100200");
		expect(error).not.toContain("params:");
		// The whole line, not just the `error` field — no other key may carry it.
		// `ts` is dropped first: a 13-digit epoch that happens to contain
		// `600100200` recurs for ~10 ms a few times a year (impl-review F8).
		const { ts: _ts, ...withoutTs } = failed[0] as Record<string, unknown>;
		expect(JSON.stringify(withoutTs)).not.toMatch(/600.?100.?200/);
	});
});

describe("calls.history", () => {
	test("returns numbers most-recently-dialed first", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?)`,
			args: [
				"a",
				"me",
				"+48600100201",
				100,
				"b",
				"me",
				"+48600100202",
				300,
				"c",
				"me",
				"+48600100203",
				200,
			],
		});

		const rows = await caller(makeCtx(true)).history();
		expect(rows.map((r) => r.e164)).toEqual([
			"+48600100202",
			"+48600100203",
			"+48600100201",
		]);
	});

	test("is scoped to the calling user", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?),(?,?,?,?)`,
			args: [
				"mine",
				"me",
				"+48600100201",
				100,
				"theirs",
				"other",
				"+48600100202",
				200,
			],
		});

		const rows = await caller(makeCtx(true)).history();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.e164).toBe("+48600100201");
	});

	test("caps the list", async () => {
		for (let i = 0; i < 12; i++) {
			await client.execute({
				sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?)`,
				args: [`n${i}`, "me", `+4860010${String(i).padStart(4, "0")}`, i],
			});
		}
		expect(await caller(makeCtx(true)).history()).toHaveLength(8);
	});

	test("rejects an unauthenticated caller", async () => {
		await expect(caller(makeCtx(false)).history()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

describe("calls.history — contact names (real LEFT JOIN)", () => {
	test("signs a known number and still returns the unsigned ones", async () => {
		// THE regression this suite exists for: with the user predicate in WHERE
		// instead of the JOIN ON, the LEFT JOIN degenerates to an INNER one and
		// the unsigned row below disappears entirely — a picker that silently
		// drops every number that has no contact.
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?),(?,?,?,?)`,
			args: [
				"signed",
				"me",
				"+48600100201",
				200,
				"unsigned",
				"me",
				"+48600100202",
				100,
			],
		});
		await seedContact("c1", "me", "Marek — warsztat", "+48600100201");

		const rows = await caller(makeCtx(true)).history();

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => [r.e164, r.contactName])).toEqual([
			["+48600100201", "Marek — warsztat"],
			["+48600100202", null],
		]);
	});

	test("a contact with no number signs nothing", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?)`,
			args: ["d", "me", "+48600100201", 100],
		});
		await seedContact("c1", "me", "Ktoś bez numeru", null);

		const rows = await caller(makeCtx(true)).history();
		expect(rows).toHaveLength(1);
		// `e164 = NULL` never equals anything in SQL, so the join simply misses —
		// but assert it, because a `LEFT JOIN` on a nullable column is exactly
		// where an accidental `IS NOT DISTINCT FROM`-style fix would go wrong.
		expect(rows[0]?.contactName).toBeNull();
	});

	test("another user's contact does not sign this user's number", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?)`,
			args: ["mine", "me", "+48600100201", 100],
		});
		// Same number, different owner. Without `contacts.user_id` in the JOIN ON
		// this leaks a foreign contact's NAME onto our screen.
		await seedContact("theirs", "other", "Nie mój kontakt", "+48600100201");

		const rows = await caller(makeCtx(true)).history();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.contactName).toBeNull();
	});

	test("deleting a contact leaves the history entry, unsigned", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?)`,
			args: ["d", "me", "+48600100201", 100],
		});
		await seedContact("c1", "me", "Marek", "+48600100201");
		expect((await caller(makeCtx(true)).history())[0]?.contactName).toBe(
			"Marek",
		);

		// Matched by VALUE, never by a foreign key — so no cascade may take the
		// dialing history with it.
		await client.execute("DELETE FROM \"memo-call_contacts\" WHERE id = 'c1'");

		const rows = await caller(makeCtx(true)).history();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.contactName).toBeNull();
	});
});

describe("calls.forget", () => {
	test("removes one number and leaves the rest", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?),(?,?,?,?)`,
			args: [
				"keep",
				"me",
				"+48600100201",
				100,
				"drop",
				"me",
				"+48600100202",
				200,
			],
		});

		await caller(makeCtx(true)).forget({ id: "drop" });

		const rows = await historyRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("keep");
	});

	test("cannot delete another user's entry", async () => {
		await client.execute({
			sql: `INSERT INTO "memo-call_dialed_numbers" (id, user_id, e164, last_used_at) VALUES (?,?,?,?)`,
			args: ["theirs", "other", "+48600100202", 200],
		});

		await caller(makeCtx(true)).forget({ id: "theirs" });

		expect(await historyRows("other")).toHaveLength(1);
	});

	test("is idempotent for an unknown id", async () => {
		await expect(
			caller(makeCtx(true)).forget({ id: "does-not-exist" }),
		).resolves.toEqual({ ok: true });
	});

	test("rejects an unauthenticated caller", async () => {
		await expect(
			caller(makeCtx(false)).forget({ id: "whatever" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
