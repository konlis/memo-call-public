import { type Client, createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
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

// Keep NextAuth out of the test graph (see conversations.test.ts for the why).
vi.mock("~/server/auth", () => ({ auth: async () => null }));

import { tagsRouter } from "~/server/api/routers/tags";
import { createCallerFactory, type createTRPCContext } from "~/server/api/trpc";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import { conversations, tags, users } from "~/server/db/schema";

// Real-libsql integration: the add/rename/remove collision-merge logic rests on
// app-code delete+update with NO unique index, and `listWithCounts` is real
// SQL (GROUP BY + aggregate ORDER BY) — a stub would lie about row counts after
// a merge and about grouping/ordering.
// Mirrors the `conversations.test.ts` harness.
const DB_PATH = makeIntegrationDbPath("tags-router");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

type Ctx = Awaited<ReturnType<typeof createTRPCContext>>;

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

function caller(ctx: Ctx) {
	return createCallerFactory(tagsRouter)(ctx);
}

const at = (iso: string) => new Date(iso);

let seq = 0;

async function seedConversation(opts: {
	userId: string;
	id?: string;
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `c-${seq}`;
	await db.insert(conversations).values({
		id,
		userId: opts.userId,
		createdAt: at("2026-06-10T10:00:00.000Z"),
	});
	return id;
}

async function seedTag(opts: {
	userId: string;
	conversationId: string;
	name: string;
	id?: string;
	isUserEdited?: boolean;
	createdAt?: Date;
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `t-${seq}`;
	await db.insert(tags).values({
		id,
		userId: opts.userId,
		conversationId: opts.conversationId,
		name: opts.name,
		isUserEdited: opts.isUserEdited ?? false,
		createdAt: opts.createdAt ?? at("2026-06-10T10:00:00.000Z"),
	});
	return id;
}

/** All tag rows on a conversation, for asserting counts/flags after a mutation. */
async function tagsOf(conversationId: string) {
	return db
		.select({
			id: tags.id,
			name: tags.name,
			isUserEdited: tags.isUserEdited,
		})
		.from(tags)
		.where(eq(tags.conversationId, conversationId));
}

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
	await db.insert(users).values({ id: "other" });
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	// Children before parents (FK): tags reference conversations.
	await client.execute('DELETE FROM "memo-call_tags"');
	await client.execute('DELETE FROM "memo-call_conversations"');
});

describe("tags.add", () => {
	test("inserts a new canonical row flagged user-edited", async () => {
		const conv = await seedConversation({ userId: "me" });

		const res = await caller(makeCtx(true)).add({
			conversationId: conv,
			name: "Pilne Zadanie", // normalizes to pilne-zadanie
		});
		expect(res).toEqual({ ok: true });

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("pilne-zadanie");
		expect(rows[0]?.isUserEdited).toBe(true);
	});

	test("collision merges onto the existing row (no duplicate, survivor flagged)", async () => {
		const conv = await seedConversation({ userId: "me" });
		// An LLM-proposed (is_user_edited=false) canonical tag already present.
		await seedTag({
			userId: "me",
			conversationId: conv,
			name: "follow-up",
			isUserEdited: false,
		});

		// Adding a raw form that normalizes to the SAME canonical name must not dup.
		await caller(makeCtx(true)).add({
			conversationId: conv,
			name: "Follow Up",
		});

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1); // merged — no duplicate
		expect(rows[0]?.name).toBe("follow-up");
		expect(rows[0]?.isUserEdited).toBe(true); // survivor flagged
	});

	test("empty-after-normalize name ⇒ BAD_REQUEST (nothing written)", async () => {
		const conv = await seedConversation({ userId: "me" });

		await expect(
			caller(makeCtx(true)).add({ conversationId: conv, name: "!!!" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(await tagsOf(conv)).toHaveLength(0);
	});

	test("whitespace-only name ⇒ BAD_REQUEST (Zod trim().min(1))", async () => {
		const conv = await seedConversation({ userId: "me" });
		await expect(
			caller(makeCtx(true)).add({ conversationId: conv, name: "   " }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("foreign conversation ⇒ NOT_FOUND (no write)", async () => {
		const otherConv = await seedConversation({ userId: "other" });
		await expect(
			caller(makeCtx(true)).add({ conversationId: otherConv, name: "x" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await tagsOf(otherConv)).toHaveLength(0);
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).add({ conversationId: "x", name: "y" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("tags.rename", () => {
	test("updates the name and flags user-edited", async () => {
		const conv = await seedConversation({ userId: "me" });
		const tagId = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "stare",
			isUserEdited: false,
		});

		await caller(makeCtx(true)).rename({ tagId, name: "Nowe Imię" });

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("nowe-imie");
		expect(rows[0]?.isUserEdited).toBe(true);
	});

	test("self-rename (normalizes to its own current name) updates in place, no self-collision", async () => {
		// Guards the `ne(tags.id, tag.id)` collision-exclusion: WITHOUT it, renaming a
		// tag to a value that normalizes to its own name would "collide" with itself,
		// delete the only row, and lose the tag entirely (data loss).
		const conv = await seedConversation({ userId: "me" });
		const tagId = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "klient",
			isUserEdited: false,
		});

		// "Klient" normalizes back to "klient" — the same row, not a collision.
		await caller(makeCtx(true)).rename({ tagId, name: "Klient" });

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1); // row survives — NOT deleted
		expect(rows[0]?.id).toBe(tagId);
		expect(rows[0]?.name).toBe("klient");
		expect(rows[0]?.isUserEdited).toBe(true); // flag still flips
	});

	test("collision with a different row merges (row count drops, survivor flagged)", async () => {
		const conv = await seedConversation({ userId: "me" });
		const survivor = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "klient",
			isUserEdited: false,
		});
		const renamed = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "sprawa",
			isUserEdited: false,
		});

		// Rename "sprawa" → "klient": collides with the survivor → merge.
		await caller(makeCtx(true)).rename({ tagId: renamed, name: "klient" });

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1); // dropped from 2 → 1
		expect(rows[0]?.id).toBe(survivor); // the renamed row was deleted
		expect(rows[0]?.name).toBe("klient");
		expect(rows[0]?.isUserEdited).toBe(true); // survivor flagged
	});

	test("does NOT merge across conversations (same name, different conversation)", async () => {
		const convA = await seedConversation({ userId: "me", id: "cA" });
		const convB = await seedConversation({ userId: "me", id: "cB" });
		await seedTag({ userId: "me", conversationId: convA, name: "wspolny" });
		const onB = await seedTag({
			userId: "me",
			conversationId: convB,
			name: "inny",
		});

		// Renaming convB's tag to "wspolny" must NOT collide with convA's tag.
		await caller(makeCtx(true)).rename({ tagId: onB, name: "wspolny" });

		expect(await tagsOf(convA)).toHaveLength(1);
		const bRows = await tagsOf(convB);
		expect(bRows).toHaveLength(1);
		expect(bRows[0]?.name).toBe("wspolny");
	});

	test("empty-after-normalize name ⇒ BAD_REQUEST (unchanged)", async () => {
		const conv = await seedConversation({ userId: "me" });
		const tagId = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "trwa",
		});

		await expect(
			caller(makeCtx(true)).rename({ tagId, name: "###" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const rows = await tagsOf(conv);
		expect(rows[0]?.name).toBe("trwa"); // untouched
	});

	test("unknown / foreign tag ⇒ NOT_FOUND", async () => {
		const otherConv = await seedConversation({ userId: "other" });
		const foreignTag = await seedTag({
			userId: "other",
			conversationId: otherConv,
			name: "obcy",
		});
		await expect(
			caller(makeCtx(true)).rename({ tagId: foreignTag, name: "x" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			caller(makeCtx(true)).rename({ tagId: "does-not-exist", name: "x" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).rename({ tagId: "x", name: "y" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("tags.remove", () => {
	test("deletes the row", async () => {
		const conv = await seedConversation({ userId: "me" });
		const tagId = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "do-usuniecia",
		});

		const res = await caller(makeCtx(true)).remove({ tagId });
		expect(res).toEqual({ ok: true });
		expect(await tagsOf(conv)).toHaveLength(0);
	});

	test("unknown / foreign tag ⇒ NOT_FOUND, row preserved", async () => {
		const otherConv = await seedConversation({ userId: "other" });
		const foreignTag = await seedTag({
			userId: "other",
			conversationId: otherConv,
			name: "obcy",
		});

		await expect(
			caller(makeCtx(true)).remove({ tagId: foreignTag }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// The cross-user row must survive (WHERE scoped on userId).
		const rows = await db
			.select({ id: tags.id })
			.from(tags)
			.where(and(eq(tags.id, foreignTag), eq(tags.userId, "other")));
		expect(rows).toHaveLength(1);
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).remove({ tagId: "x" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("tags.listWithCounts", () => {
	test("groups by name with usage counts, most used first, ties by name ascending", async () => {
		const convA = await seedConversation({ userId: "me", id: "cA" });
		const convB = await seedConversation({ userId: "me", id: "cB" });
		const convC = await seedConversation({ userId: "me", id: "cC" });
		// "klient" ×3, "zadanie" ×2, "alfa" ×1, "beta" ×1 → count desc, then name
		// asc (`beta`/`alfa` tie at 1 and must come out alphabetical; `zadanie`
		// at 2 must NOT sort after `alfa` just because it is a later letter).
		await seedTag({ userId: "me", conversationId: convA, name: "klient" });
		await seedTag({ userId: "me", conversationId: convB, name: "klient" });
		await seedTag({ userId: "me", conversationId: convC, name: "klient" });
		await seedTag({ userId: "me", conversationId: convA, name: "zadanie" });
		await seedTag({ userId: "me", conversationId: convB, name: "zadanie" });
		await seedTag({ userId: "me", conversationId: convC, name: "beta" });
		await seedTag({ userId: "me", conversationId: convB, name: "alfa" });

		const res = await caller(makeCtx(true)).listWithCounts();
		expect(res).toEqual([
			{ name: "klient", count: 3, isUserEdited: false },
			{ name: "zadanie", count: 2, isUserEdited: false },
			{ name: "alfa", count: 1, isUserEdited: false },
			{ name: "beta", count: 1, isUserEdited: false },
		]);
	});

	test("isUserEdited is true when ANY row of that name is user-edited, false only when none is", async () => {
		const convA = await seedConversation({ userId: "me", id: "cA" });
		const convB = await seedConversation({ userId: "me", id: "cB" });
		// "klient": one auto row + one user-edited row → true (a single edited
		// row is enough — the user's decision must not be outvoted by auto rows).
		await seedTag({
			userId: "me",
			conversationId: convA,
			name: "klient",
			isUserEdited: false,
		});
		await seedTag({
			userId: "me",
			conversationId: convB,
			name: "klient",
			isUserEdited: true,
		});
		// "auto": two auto rows → false (the negative control — without it a
		// `max()` that always returned 1 would pass the assertion above).
		await seedTag({ userId: "me", conversationId: convA, name: "auto" });
		await seedTag({ userId: "me", conversationId: convB, name: "auto" });

		const res = await caller(makeCtx(true)).listWithCounts();
		expect(res).toEqual([
			{ name: "auto", count: 2, isUserEdited: false },
			{ name: "klient", count: 2, isUserEdited: true },
		]);
		// The flag is a real boolean on the wire, not SQLite's 0/1.
		expect(res.map((r) => typeof r.isUserEdited)).toEqual([
			"boolean",
			"boolean",
		]);
	});

	test("excludes another user's tags (user-scope isolation, counts included)", async () => {
		const mine = await seedConversation({ userId: "me", id: "cMine" });
		const theirs = await seedConversation({ userId: "other", id: "cTheirs" });
		await seedTag({ userId: "me", conversationId: mine, name: "moje" });
		await seedTag({ userId: "other", conversationId: theirs, name: "obce" });
		// Same name on the other user's conversation must NOT inflate my count.
		await seedTag({ userId: "other", conversationId: theirs, name: "moje" });

		const res = await caller(makeCtx(true)).listWithCounts();
		expect(res).toEqual([{ name: "moje", count: 1, isUserEdited: false }]);
	});

	test("empty when the user has no tags", async () => {
		expect(await caller(makeCtx(true)).listWithCounts()).toEqual([]);
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(caller(makeCtx(false)).listWithCounts()).rejects.toMatchObject(
			{ code: "UNAUTHORIZED" },
		);
	});
});

describe("tags.mergeGlobal", () => {
	/** Every row of `name` across the whole table (both users), for row-count assertions. */
	async function rowsNamed(name: string) {
		return db
			.select({
				id: tags.id,
				userId: tags.userId,
				conversationId: tags.conversationId,
				isUserEdited: tags.isUserEdited,
			})
			.from(tags)
			.where(eq(tags.name, name));
	}

	test("renames in place where the target is absent (no row count change)", async () => {
		const convA = await seedConversation({ userId: "me", id: "cA" });
		const convB = await seedConversation({ userId: "me", id: "cB" });
		const idA = await seedTag({
			userId: "me",
			conversationId: convA,
			name: "faktura",
		});
		const idB = await seedTag({
			userId: "me",
			conversationId: convB,
			name: "faktura",
		});

		const res = await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});
		expect(res).toEqual({
			ok: true,
			conversations: 2,
			renamedRows: 2,
			deletedRows: 0,
		});

		// Same rows, new name — a rename, not a delete+insert.
		const after = await rowsNamed("faktury");
		expect(after.map((r) => r.id).sort()).toEqual([idA, idB].sort());
		// Seeded as auto rows; the merge flags them (F2).
		expect(after.every((r) => r.isUserEdited)).toBe(true);
		expect(await rowsNamed("faktura")).toEqual([]);
	});

	test("collapses the duplicate where the target is present (row count drops)", async () => {
		const conv = await seedConversation({ userId: "me" });
		await seedTag({ userId: "me", conversationId: conv, name: "faktura" });
		const survivor = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "faktury",
		});

		const res = await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});
		expect(res).toMatchObject({
			conversations: 1,
			renamedRows: 0,
			deletedRows: 1,
		});

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1); // 2 → 1: the duplicate is gone
		expect(rows[0]?.id).toBe(survivor);
		expect(rows[0]?.name).toBe("faktury");
	});

	test("flags EVERY survivor user-edited, on both branches, regardless of the incoming flags", async () => {
		// A global merge is a user decision about the vocabulary, exactly like
		// `rename` — and `is_user_edited=true` is the ONLY thing `reconcileTags`
		// under the `merge` policy spares, so a survivor left at `false` is
		// re-split by the next re-analysis (impl-review phase 4, F2).
		//
		// (a) collapse branch, flag came from the DELETED `from` row.
		const convA = await seedConversation({ userId: "me", id: "cA" });
		await seedTag({
			userId: "me",
			conversationId: convA,
			name: "faktura",
			isUserEdited: true,
		});
		await seedTag({
			userId: "me",
			conversationId: convA,
			name: "faktury",
			isUserEdited: false,
		});
		// (b) rename branch, neither side edited — the merge itself is the edit.
		const convB = await seedConversation({ userId: "me", id: "cB" });
		await seedTag({
			userId: "me",
			conversationId: convB,
			name: "faktura",
			isUserEdited: false,
		});
		// (c) collapse branch, neither side edited.
		const convC = await seedConversation({ userId: "me", id: "cC" });
		await seedTag({
			userId: "me",
			conversationId: convC,
			name: "faktura",
			isUserEdited: false,
		});
		await seedTag({
			userId: "me",
			conversationId: convC,
			name: "faktury",
			isUserEdited: false,
		});
		// (d) NEGATIVE CONTROL: a bystander tag on a conversation the merge does
		// touch. "Flag everything" is now the rule for survivors, so the control
		// that still bites is a row the merge must NOT flag — without it an
		// `UPDATE … SET is_user_edited = 1` missing its id predicate would pass.
		await seedTag({
			userId: "me",
			conversationId: convA,
			name: "bystander",
			isUserEdited: false,
		});

		await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});

		const byConv = new Map(
			(await rowsNamed("faktury")).map((r) => [r.conversationId, r]),
		);
		expect(byConv.get("cA")?.isUserEdited).toBe(true);
		expect(byConv.get("cB")?.isUserEdited).toBe(true);
		expect(byConv.get("cC")?.isUserEdited).toBe(true);
		expect((await rowsNamed("bystander"))[0]?.isUserEdited).toBe(false);
	});

	test("leaves no row carrying the old name, across a mix of both branches", async () => {
		const convA = await seedConversation({ userId: "me", id: "cA" });
		const convB = await seedConversation({ userId: "me", id: "cB" });
		const convC = await seedConversation({ userId: "me", id: "cC" });
		await seedTag({ userId: "me", conversationId: convA, name: "faktura" });
		await seedTag({ userId: "me", conversationId: convB, name: "faktura" });
		await seedTag({ userId: "me", conversationId: convB, name: "faktury" });
		await seedTag({ userId: "me", conversationId: convC, name: "faktura" });
		await seedTag({ userId: "me", conversationId: convC, name: "inny" });

		const res = await caller(makeCtx(true)).mergeGlobal({
			from: "Faktura", // raw input; normalization is what the merge keys on
			to: "faktury",
		});
		// Pin the rename/delete SPLIT, not just the end state: convA and convC
		// take the rename branch, convB the collapse branch. Asserting only the
		// final rows would pass even if every row went down one branch.
		expect(res).toEqual({
			ok: true,
			conversations: 3,
			renamedRows: 2,
			deletedRows: 1,
		});

		expect(await rowsNamed("faktura")).toEqual([]);
		// The union of both sets, one row per conversation, plus the bystander.
		const counts = await caller(makeCtx(true)).listWithCounts();
		expect(counts).toEqual([
			// The survivors are user-edited (the merge is the edit); the bystander
			// tag on convC, untouched by the merge, is the control that stays false.
			{ name: "faktury", count: 3, isUserEdited: true },
			{ name: "inny", count: 1, isUserEdited: false },
		]);
	});

	test("degenerate same-name duplicates on one conversation collapse instead of re-duplicating", async () => {
		// No unique index on (conversation_id, name) ⇒ this state is representable.
		// Renaming both rows would manufacture a fresh duplicate of the target.
		const conv = await seedConversation({ userId: "me" });
		await seedTag({ userId: "me", conversationId: conv, name: "faktura" });
		await seedTag({
			userId: "me",
			conversationId: conv,
			name: "faktura",
			isUserEdited: true,
		});

		const res = await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});
		expect(res).toMatchObject({
			conversations: 1,
			renamedRows: 1,
			deletedRows: 1,
		});

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("faktury");
		expect(rows[0]?.isUserEdited).toBe(true); // every survivor is flagged (F2)
	});

	test("collapses degenerate duplicates of the TARGET name too, but only on conversations the merge touches", async () => {
		// Symmetric with the `from` side. Representable because there is no unique
		// index on (conversation_id, name); left behind, the extra target row makes
		// `listWithCounts` count that conversation twice (impl-review phase 4, F5).
		const conv = await seedConversation({ userId: "me", id: "cA" });
		await seedTag({ userId: "me", conversationId: conv, name: "faktura" });
		const survivor = await seedTag({
			userId: "me",
			conversationId: conv,
			name: "faktury",
		});
		await seedTag({ userId: "me", conversationId: conv, name: "faktury" });
		// A conversation with the same degenerate duplicate but NO `from` row is
		// NOT part of this merge and must be left exactly as it was — the merge
		// tidies what it touches, it is not a table-wide dedup pass.
		const untouched = await seedConversation({ userId: "me", id: "cB" });
		await seedTag({ userId: "me", conversationId: untouched, name: "faktury" });
		await seedTag({ userId: "me", conversationId: untouched, name: "faktury" });

		await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});

		const touchedRows = await tagsOf(conv);
		expect(touchedRows).toHaveLength(1); // 3 → 1
		expect(touchedRows[0]?.id).toBe(survivor);
		expect(await tagsOf(untouched)).toHaveLength(2); // untouched, still 2
		// The cloud therefore counts each conversation once for the touched one.
		const counts = await caller(makeCtx(true)).listWithCounts();
		expect(counts.find((c) => c.name === "faktury")?.count).toBe(3);
	});

	test("rolls back completely when a write fails mid-merge (the ONE-transaction claim)", async () => {
		// `tags.ts` opens its merge with "the whole plan runs in ONE transaction so
		// a half-merged vocabulary cannot exist". That was a comment and nothing
		// more (impl-review phase 4, F6) — this test breaks it on purpose.
		//
		// The seed spans BOTH branches, so the forced failure lands after a real
		// DELETE has already run and with a rename still pending: the exact
		// half-merged state the claim says is unreachable.
		const convA = await seedConversation({ userId: "me", id: "cA" });
		const convB = await seedConversation({ userId: "me", id: "cB" });
		await seedTag({ userId: "me", conversationId: convA, name: "faktura" });
		await seedTag({ userId: "me", conversationId: convB, name: "faktura" });
		await seedTag({ userId: "me", conversationId: convB, name: "faktury" });
		const before = await rowsNamed("faktura");
		expect(before).toHaveLength(2);

		// A db whose transaction hands the mutation a tx that throws on the first
		// `update` — i.e. AFTER the delete the mutation issues first. Proxied
		// rather than stubbed so every other call reaches the real libsql driver
		// and the real ROLLBACK is what we observe (a stub would prove nothing
		// about the driver, per the repo's stub-db lesson).
		const bind = (target: object, prop: string | symbol) => {
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		};
		// Records that a DELETE really was issued before the throw. Without this
		// the test passes vacuously: a proxy that threw BEFORE any write would
		// leave the rows intact too, and prove nothing about rollback.
		let deleteIssued = false;
		const failingDb = new Proxy(db, {
			get(target, prop) {
				if (prop !== "transaction") return bind(target, prop);
				return (fn: (tx: unknown) => unknown) =>
					// biome-ignore lint/suspicious/noExplicitAny: test-only proxy seam
					(target as any).transaction((tx: object) =>
						fn(
							new Proxy(tx, {
								get(txTarget, txProp) {
									if (txProp === "delete") deleteIssued = true;
									if (txProp === "update") {
										throw new Error("simulated failure after delete");
									}
									return bind(txTarget, txProp);
								},
							}),
						),
					);
			},
		});
		const failingCtx = {
			...makeCtx(true),
			db: failingDb,
		} as unknown as Ctx;

		await expect(
			caller(failingCtx).mergeGlobal({ from: "faktura", to: "faktury" }),
		).rejects.toThrow(/simulated failure/);

		expect(deleteIssued).toBe(true); // the failure really did land mid-write
		// Nothing moved: both `faktura` rows are back, with their original ids.
		const after = await rowsNamed("faktura");
		expect(after.map((r) => r.id).sort()).toEqual(
			before.map((r) => r.id).sort(),
		);
		expect(await rowsNamed("faktury")).toHaveLength(1);
		expect(await tagsOf(convA)).toHaveLength(1);
		expect(await tagsOf(convB)).toHaveLength(2);
	});

	test("merging a tag into itself ⇒ BAD_REQUEST (nothing written)", async () => {
		const conv = await seedConversation({ userId: "me" });
		await seedTag({ userId: "me", conversationId: conv, name: "faktury" });

		await expect(
			caller(makeCtx(true)).mergeGlobal({ from: "faktury", to: "faktury" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Case/diacritic variants normalize to the same name — also a self-merge.
		await expect(
			caller(makeCtx(true)).mergeGlobal({ from: "Faktury", to: "faktury" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(await tagsOf(conv)).toHaveLength(1);
	});

	test("empty-after-normalize name on either side ⇒ BAD_REQUEST (nothing written)", async () => {
		const conv = await seedConversation({ userId: "me" });
		await seedTag({ userId: "me", conversationId: conv, name: "faktura" });

		await expect(
			caller(makeCtx(true)).mergeGlobal({ from: "!!!", to: "faktury" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller(makeCtx(true)).mergeGlobal({ from: "faktura", to: "???" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller(makeCtx(true)).mergeGlobal({ from: "   ", to: "faktury" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const rows = await tagsOf(conv);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("faktura");
	});

	test("never touches another user's rows of the same names", async () => {
		const mine = await seedConversation({ userId: "me", id: "cMine" });
		const theirs = await seedConversation({ userId: "other", id: "cTheirs" });
		await seedTag({ userId: "me", conversationId: mine, name: "faktura" });
		await seedTag({ userId: "other", conversationId: theirs, name: "faktura" });
		await seedTag({ userId: "other", conversationId: theirs, name: "faktury" });

		const res = await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});
		expect(res).toMatchObject({ conversations: 1 });

		// The other user still has BOTH names, untouched by my merge.
		const theirRows = (await rowsNamed("faktura")).filter(
			(r) => r.userId === "other",
		);
		expect(theirRows).toHaveLength(1);
		expect(
			(await rowsNamed("faktury")).filter((r) => r.userId === "other"),
		).toHaveLength(1);
	});

	test("is a zero no-op when the source name has no rows (idempotent on re-run)", async () => {
		const conv = await seedConversation({ userId: "me" });
		await seedTag({ userId: "me", conversationId: conv, name: "faktury" });

		const res = await caller(makeCtx(true)).mergeGlobal({
			from: "faktura",
			to: "faktury",
		});
		expect(res).toEqual({
			ok: true,
			conversations: 0,
			renamedRows: 0,
			deletedRows: 0,
		});
		expect(await tagsOf(conv)).toHaveLength(1);
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).mergeGlobal({ from: "a", to: "b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
