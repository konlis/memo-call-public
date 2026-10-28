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

import { contactsRouter } from "~/server/api/routers/contacts";
import { createCallerFactory, type createTRPCContext } from "~/server/api/trpc";
import {
	createContactInput,
	updateContactInput,
} from "~/server/contacts/schema";
import { isUniqueViolation } from "~/server/contacts/unique-violation";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import { users } from "~/server/db/schema";

// Real-libsql integration harness (mirrors projects.test.ts). A stub db cannot
// prove any of the three things this slice actually rests on: that the unique
// index is PARTIAL (so numberless contacts coexist), that a duplicate number is
// rejected by the database and not merely by the pre-check, and that the error
// libsql raises is the shape `isUniqueViolation` recognizes.
const DB_PATH = makeIntegrationDbPath("contacts-router");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

type Ctx = Awaited<ReturnType<typeof createTRPCContext>>;

/** Build a tRPC ctx; `authed=false` yields a null session (UNAUTHORIZED path). */
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

const caller = (ctx: Ctx) => createCallerFactory(contactsRouter)(ctx);
const me = () => caller(makeCtx(true, "me"));
const other = () => caller(makeCtx(true, "other"));

/** Raw row read — bypasses drizzle so the assertion sees what SQLite stored. */
async function rawRows(): Promise<
	{ id: string; user_id: string; name: string; e164: string | null }[]
> {
	const r = await client.execute(
		'SELECT id, user_id, name, e164 FROM "memo-call_contacts" ORDER BY name',
	);
	return r.rows as unknown as {
		id: string;
		user_id: string;
		name: string;
		e164: string | null;
	}[];
}

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
	// A second user so the scoping describes have someone to be isolated from
	// (the migration seeds only 'me').
	await db.insert(users).values({ id: "other" });
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_contacts"');
	vi.restoreAllMocks();
});

// --- Pure-schema validation oracle (no DB). ---
describe("contact input schemas", () => {
	test("createContactInput trims the name and caps it at 60", () => {
		expect(createContactInput.parse({ name: "  Marek  " }).name).toBe("Marek");
		expect(createContactInput.safeParse({ name: "x".repeat(61) }).success).toBe(
			false,
		);
		expect(createContactInput.safeParse({ name: "   " }).success).toBe(false);
	});

	test("createContactInput accepts an absent e164 (contact with no number)", () => {
		const parsed = createContactInput.parse({ name: "Marek" });
		expect(parsed.e164).toBeUndefined();
	});

	// The three intents of an edit. `null` is the ONLY way to clear a number;
	// `""` must NOT be accepted, or the router has to guess whether an empty
	// string was a form artefact or an intent.
	test("updateContactInput: null clears, empty string is rejected", () => {
		expect(
			updateContactInput.safeParse({ id: "c1", name: "Marek", e164: null })
				.success,
		).toBe(true);
		expect(
			updateContactInput.safeParse({ id: "c1", name: "Marek", e164: "" })
				.success,
		).toBe(false);
		expect(
			updateContactInput.parse({
				id: "c1",
				name: "Marek",
				e164: " 600 100 200 ",
			}).e164,
		).toBe("600 100 200");
	});

	// `.nullable()` leaves the KEY required — there is no "leave it alone" state.
	// Pinned because the docblock asserted the opposite until impl-review F1, and
	// a claim about validation that nothing checks is how that drifts again: the
	// phase-2 edit form must send `e164` on EVERY submit.
	test("updateContactInput has no leave-alone state: a missing e164 is rejected", () => {
		expect(
			updateContactInput.safeParse({ id: "c1", name: "Marek" }).success,
		).toBe(false);
		expect(
			updateContactInput.safeParse({ id: "c1", name: "Marek", e164: undefined })
				.success,
		).toBe(false);
	});
});

describe("contacts.create", () => {
	test("creates a contact with a number, normalized to E.164", async () => {
		const row = await me().create({ name: "Marek", e164: "600 100 200" });
		expect(row?.name).toBe("Marek");
		expect(row?.e164).toBe("+48600100200");
	});

	test("creates a contact with no number at all", async () => {
		const row = await me().create({ name: "Anna" });
		expect(row?.e164).toBeNull();
	});

	// The load-bearing proof that `contact_user_e164_uq` is PARTIAL. A full
	// unique index over (user_id, e164) would still permit this in SQLite (NULLs
	// compare distinct), so the assertion is about the outcome the product needs,
	// not about SQLite trivia: any number of numberless contacts may coexist.
	test("two contacts without a number coexist", async () => {
		await me().create({ name: "Anna" });
		await me().create({ name: "Bartek" });
		const rows = await rawRows();
		expect(rows.map((r) => r.name)).toEqual(["Anna", "Bartek"]);
		expect(rows.every((r) => r.e164 === null)).toBe(true);
	});

	test("a duplicate number is CONFLICT, and the message names the holder", async () => {
		await me().create({ name: "Marek", e164: "+48600100200" });
		await expect(
			me().create({ name: "Marek (drugi)", e164: "+48600100200" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			me().create({ name: "Marek (drugi)", e164: "+48600100200" }),
		).rejects.toThrow(/Marek/);
	});

	// Normalization happens BEFORE the uniqueness check, so three spellings of
	// one number are one contact — the same property `dialed_numbers` relies on.
	test("+48600100200, 600 100 200 and 0048600100200 all collide", async () => {
		await me().create({ name: "Marek", e164: "+48600100200" });
		for (const spelling of ["600 100 200", "0048600100200", "48600100200"]) {
			await expect(
				me().create({ name: `dup-${spelling}`, e164: spelling }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		}
		expect(await rawRows()).toHaveLength(1);
	});

	test("a non-Polish number is BAD_REQUEST, not a stored contact", async () => {
		await expect(
			me().create({ name: "Foreign", e164: "+441632960000" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(await rawRows()).toHaveLength(0);
	});
});

describe("contacts.list", () => {
	test("returns this user's contacts alphabetically, and nobody else's", async () => {
		await me().create({ name: "Zenon" });
		await me().create({ name: "Adam", e164: "600100200" });
		await other().create({ name: "Cudzy", e164: "600100201" });

		const mine = await me().list();
		expect(mine.map((c) => c.name)).toEqual(["Adam", "Zenon"]);
		expect(mine.map((c) => c.e164)).toEqual(["+48600100200", null]);
	});
});

describe("contacts.update", () => {
	test("renames and sets a number", async () => {
		const row = await me().create({ name: "Marek" });
		await me().update({
			id: row?.id ?? "",
			name: "Marek — warsztat",
			e164: "600100200",
		});
		const [stored] = await rawRows();
		expect(stored?.name).toBe("Marek — warsztat");
		expect(stored?.e164).toBe("+48600100200");
	});

	// `e164: null` is the one way to clear a number. It must land as SQL NULL —
	// not as "", not as BAD_REQUEST.
	test("e164: null clears the number", async () => {
		const row = await me().create({ name: "Marek", e164: "600100200" });
		await me().update({ id: row?.id ?? "", name: "Marek", e164: null });
		const [stored] = await rawRows();
		expect(stored?.e164).toBeNull();
	});

	test("clearing works even when another numberless contact already exists", async () => {
		await me().create({ name: "Anna" });
		const row = await me().create({ name: "Marek", e164: "600100200" });
		await me().update({ id: row?.id ?? "", name: "Marek", e164: null });
		const rows = await rawRows();
		expect(rows.every((r) => r.e164 === null)).toBe(true);
	});

	test("taking another contact's number is CONFLICT", async () => {
		await me().create({ name: "Marek", e164: "600100200" });
		const row = await me().create({ name: "Anna", e164: "600100201" });
		await expect(
			me().update({ id: row?.id ?? "", name: "Anna", e164: "600100200" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	test("keeping its own number is not a self-collision", async () => {
		const row = await me().create({ name: "Marek", e164: "600100200" });
		await me().update({
			id: row?.id ?? "",
			name: "Marek nowy",
			e164: "600 100 200",
		});
		const [stored] = await rawRows();
		expect(stored?.name).toBe("Marek nowy");
		expect(stored?.e164).toBe("+48600100200");
	});

	test("another user's contact id is NOT_FOUND, and is left untouched", async () => {
		const foreign = await other().create({ name: "Cudzy", e164: "600100201" });
		await expect(
			me().update({ id: foreign?.id ?? "", name: "Przejęty", e164: null }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const rows = await rawRows();
		expect(rows[0]?.name).toBe("Cudzy");
	});
});

describe("contacts.delete", () => {
	test("deletes own contact", async () => {
		const row = await me().create({ name: "Marek" });
		await me().delete({ id: row?.id ?? "" });
		expect(await rawRows()).toHaveLength(0);
	});

	test("another user's contact id is NOT_FOUND, and the row survives", async () => {
		const foreign = await other().create({ name: "Cudzy" });
		await expect(me().delete({ id: foreign?.id ?? "" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await rawRows()).toHaveLength(1);
	});
});

describe("auth boundary", () => {
	test("all four procedures reject a missing session", async () => {
		const anon = caller(makeCtx(false));
		await expect(anon.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(anon.create({ name: "X" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(
			anon.update({ id: "x", name: "X", e164: null }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(anon.delete({ id: "x" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

/**
 * The race between `create`'s SELECT and its INSERT cannot be reproduced in a
 * suite — SQLite has ONE writer lock, so a "concurrent" insert from a test is
 * serialized and proves nothing about concurrency. What CAN be proven, and is
 * the thing that actually matters, is that the error the database raises on a
 * genuine duplicate is the shape the catch-block predicate recognizes. So: force
 * a real duplicate INSERT through the raw client, capture the real libsql error
 * object, and feed THAT to the predicate.
 */
describe("isUniqueViolation", () => {
	test("recognizes the real libsql error from a duplicate INSERT", async () => {
		await me().create({ name: "Marek", e164: "+48600100200" });
		let captured: unknown;
		try {
			await client.execute({
				sql: 'INSERT INTO "memo-call_contacts" (id, user_id, name, e164) VALUES (?, ?, ?, ?)',
				args: ["forced-dup", "me", "Duplikat", "+48600100200"],
			});
		} catch (err) {
			captured = err;
		}
		expect(captured).toBeDefined();
		expect(isUniqueViolation(captured)).toBe(true);
	});

	// Negative control. Without this the predicate could be `() => true` and the
	// test above would still pass — and a `true`-for-everything predicate is
	// exactly the silent failure the split-out function exists to prevent.
	test("rejects an unrelated error", () => {
		expect(isUniqueViolation(new Error("boom"))).toBe(false);
		expect(isUniqueViolation(null)).toBe(false);
		expect(isUniqueViolation("UNIQUE constraint failed")).toBe(false);
	});

	// The other half of the negative control, at the router: an insert failure
	// the predicate rejects must NOT be dressed up as CONFLICT. A FK violation
	// (an unknown user_id, with `PRAGMA foreign_keys = ON`) is a real one.
	test("create does not turn a non-unique failure into CONFLICT", async () => {
		const ghost = caller(makeCtx(true, "ghost-user-that-does-not-exist"));
		await expect(
			ghost.create({ name: "Widmo", e164: "600100200" }),
		).rejects.toThrow();
		await expect(
			ghost.create({ name: "Widmo", e164: "600100200" }),
		).rejects.not.toMatchObject({ code: "CONFLICT" });
	});
});

/**
 * The audit assertion is POSITIVE and EXHAUSTIVE — the exact key set — not
 * "does not contain `name`". Absence is satisfied by a typo'd field name and by
 * the audit never having been written at all, so it can only ever prove that
 * one spelling is missing (lessons.md; plan-review F3). A contact's NAME is the
 * identity here, which is why this is worth a dedicated test.
 */
describe("audit lines", () => {
	const EXPECTED_KEYS = ["contactId", "event", "ts", "userId"];

	async function keysOfEveryAuditLine(
		run: () => Promise<unknown>,
	): Promise<{ keys: string[]; events: string[] }> {
		// Collect into our own array rather than reading `spy.mock.calls` later:
		// `mockRestore()` resets the recorded calls as well as the implementation,
		// so a read after the restore sees nothing.
		const captured: string[] = [];
		const spy = vi
			.spyOn(console, "error")
			.mockImplementation((...args: unknown[]) => {
				captured.push(String(args[0]));
			});
		try {
			await run();
		} finally {
			spy.mockRestore();
		}
		const lines = captured.map(
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		);
		expect(lines.length).toBeGreaterThan(0);
		return {
			keys: lines.flatMap((line) => Object.keys(line).sort()),
			events: lines.map((line) => String(line.event)),
		};
	}

	test("create / update / delete each log exactly {contactId, event, ts, userId}", async () => {
		const created = await me().create({ name: "Marek", e164: "600100200" });
		const id = created?.id ?? "";

		for (const [label, run] of [
			["create", () => me().create({ name: "Anna", e164: "600100201" })],
			["update", () => me().update({ id, name: "Marek II", e164: null })],
			["delete", () => me().delete({ id })],
		] as const) {
			const { keys, events } = await keysOfEveryAuditLine(run);
			expect(keys, `${label} audit keys`).toEqual(EXPECTED_KEYS);
			expect(events[0], `${label} audit event`).toMatch(/^contact\./);
		}
	});
});
