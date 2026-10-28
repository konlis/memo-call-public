import { type Client, createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
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

import {
	type ConversationsRouterDeps,
	createConversationsRouter,
} from "~/server/api/routers/conversations";
import { createCallerFactory, type createTRPCContext } from "~/server/api/trpc";
import { UNASSIGNED_PROJECT } from "~/server/conversations/filter";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import {
	type CounterpartyState,
	contacts,
	conversations,
	processingJobs,
	projects,
	tags,
	transcriptEdits,
	users,
} from "~/server/db/schema";
import type { Analysis } from "~/server/llm/schemas";
import type { TranscriptSegment } from "~/server/stt/types";
import { telephony } from "~/server/telephony";

// Real-libsql integration test: the list query's user-scoping, the
// conversations⟕projects join, the (createdAt desc, id desc) ordering, the
// keyset cursor, and the two-query latest-job status derivation are all real SQL
// + reduction a stub would lie about. Mirrors the `jobs.test.ts` harness.
const DB_PATH = makeIntegrationDbPath("conversations-router");
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

// Default deps: a no-op reanalyze kickoff so existing tests (which never call
// `reanalyze`) fire no side effect. The reanalyze tests pass a spy instead.
const NOOP_DEPS: ConversationsRouterDeps = { onReanalyze: () => {} };

function caller(ctx: Ctx, deps: ConversationsRouterDeps = NOOP_DEPS) {
	return createCallerFactory(createConversationsRouter(deps))(ctx);
}

const at = (iso: string) => new Date(iso);

/** A schema-valid, non-empty analysis payload (marks a conversation "done"). */
function analysisWith(summary: string): Analysis {
	return {
		summary,
		keyInsights: [],
		decisions: [],
		actionItems: [],
		candidateTags: [],
	};
}

let seq = 0;

async function seedConversation(opts: {
	userId: string;
	createdAt: Date;
	id?: string;
	category?: string | null;
	analysis?: Analysis | null;
	projectId?: string | null;
	categoryOverridden?: boolean;
	projectOverridden?: boolean;
	transcriptSegments?: TranscriptSegment[] | null;
	transcriptLanguage?: string | null;
	durationMs?: number | null;
	// FR-025. `counterpartyState` omitted ⇒ the column stays NULL, i.e. a row
	// captured before FR-025 — the default on purpose, so every pre-existing
	// test keeps exercising the "no counterparty line" shape.
	counterpartyState?: CounterpartyState;
	counterpartyE164?: string | null;
	counterpartyNameHint?: string | null;
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `c-${seq}`;
	await db.insert(conversations).values({
		id,
		userId: opts.userId,
		createdAt: opts.createdAt,
		category: opts.category ?? null,
		analysis: opts.analysis ?? null,
		projectId: opts.projectId ?? null,
		categoryOverridden: opts.categoryOverridden ?? false,
		projectOverridden: opts.projectOverridden ?? false,
		transcriptSegments: opts.transcriptSegments ?? null,
		transcriptLanguage: opts.transcriptLanguage ?? null,
		durationMs: opts.durationMs ?? null,
		counterpartyState: opts.counterpartyState,
		counterpartyE164: opts.counterpartyE164 ?? null,
		counterpartyNameHint: opts.counterpartyNameHint ?? null,
	});
	return id;
}

async function seedContact(opts: {
	userId: string;
	name: string;
	e164?: string | null;
	id?: string;
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `ct-${seq}`;
	await db.insert(contacts).values({
		id,
		userId: opts.userId,
		name: opts.name,
		e164: opts.e164 ?? null,
	});
	return id;
}

async function seedJob(opts: {
	userId: string;
	conversationId: string;
	status: string;
	updatedAt: Date;
	id?: string;
	kind?: "analyze" | "reanalyze";
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `j-${seq}`;
	await db.insert(processingJobs).values({
		id,
		userId: opts.userId,
		conversationId: opts.conversationId,
		status: opts.status,
		updatedAt: opts.updatedAt,
		kind: opts.kind ?? "analyze",
	});
	return id;
}

async function seedProject(opts: {
	userId: string;
	name: string;
	id?: string;
	category?: "praca" | "prywatne";
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `p-${seq}`;
	await db.insert(projects).values({
		id,
		userId: opts.userId,
		name: opts.name,
		category: opts.category ?? "praca",
	});
	return id;
}

async function seedTag(opts: {
	userId: string;
	conversationId: string;
	name: string;
	id?: string;
}): Promise<string> {
	seq += 1;
	const id = opts.id ?? `t-${seq}`;
	await db.insert(tags).values({
		id,
		userId: opts.userId,
		conversationId: opts.conversationId,
		name: opts.name,
	});
	return id;
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
	// Children before parents (FK); projects are referenced by conversations.
	await client.execute('DELETE FROM "memo-call_reconcile_tombstones"');
	await client.execute('DELETE FROM "memo-call_processing_jobs"');
	await client.execute('DELETE FROM "memo-call_conversations"');
	await client.execute('DELETE FROM "memo-call_projects"');
	await client.execute('DELETE FROM "memo-call_contacts"');
});

describe("conversations.list — user scoping", () => {
	test("returns only the current user's conversations", async () => {
		const mine = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedConversation({
			userId: "other",
			createdAt: at("2026-06-10T11:00:00.000Z"),
		});

		const res = await caller(makeCtx(true)).list({});

		expect(res.items.map((i) => i.id)).toEqual([mine]);
	});
});

describe("conversations.list — order + stability", () => {
	test("newest-first by (createdAt desc, id desc), with a same-second tie-break", async () => {
		// Two rows share the 10:00:02 second; the id tie-break orders them.
		await seedConversation({
			id: "c-A",
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedConversation({
			id: "c-B",
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
		});
		await seedConversation({
			id: "c-C-1",
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
		});
		await seedConversation({
			id: "c-C-2",
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
		});

		const res = await caller(makeCtx(true)).list({});

		// 10:00:02 rows first (desc id: c-C-2 > c-C-1), then c-B, then c-A.
		expect(res.items.map((i) => i.id)).toEqual([
			"c-C-2",
			"c-C-1",
			"c-B",
			"c-A",
		]);
	});

	test("paging across a same-second boundary skips/duplicates nothing", async () => {
		await seedConversation({
			id: "c-A",
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedConversation({
			id: "c-B",
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
		});
		await seedConversation({
			id: "c-C-1",
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
		});
		await seedConversation({
			id: "c-C-2",
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
		});

		// Page size 2 splits the same-second pair (c-C-2 | c-C-1) across the boundary.
		const p1 = await caller(makeCtx(true)).list({ limit: 2 });
		expect(p1.items.map((i) => i.id)).toEqual(["c-C-2", "c-C-1"]);
		expect(p1.nextCursor).not.toBeNull();

		const p2 = await caller(makeCtx(true)).list({
			limit: 2,
			cursor: p1.nextCursor ?? undefined,
		});
		expect(p2.items.map((i) => i.id)).toEqual(["c-B", "c-A"]);
		expect(p2.nextCursor).toBeNull();
	});
});

describe("conversations.list — category filter", () => {
	test.each([
		{ name: "undefined ⇒ all incl. NULL-category", filter: undefined },
		{ name: "praca ⇒ only praca", filter: { category: "praca" as const } },
		{
			name: "prywatne ⇒ only prywatne",
			filter: { category: "prywatne" as const },
		},
	])("$name", async ({ filter }) => {
		const pracaId = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			category: "praca",
		});
		const prywatneId = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			category: "prywatne",
		});
		const nullId = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			category: null,
		});

		const res = await caller(makeCtx(true)).list({ filter });
		const ids = res.items.map((i) => i.id).sort();

		const expected =
			filter === undefined
				? [pracaId, prywatneId, nullId].sort()
				: filter.category === "praca"
					? [pracaId]
					: [prywatneId];
		expect(ids).toEqual(expected);
		// NULL-category rows appear ONLY under the "all" (undefined) filter.
		expect(ids.includes(nullId)).toBe(filter === undefined);
	});
});

describe("conversations.list — tag AND filter (S-05 / FR-019)", () => {
	test("a single tag returns only conversations carrying it", async () => {
		const klient = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
		});
		const inny = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedTag({ userId: "me", conversationId: klient, name: "klient" });
		await seedTag({ userId: "me", conversationId: inny, name: "inny" });

		const res = await caller(makeCtx(true)).list({
			filter: { tags: ["klient"] },
		});
		expect(res.items.map((i) => i.id)).toEqual([klient]);
	});

	test("two tags are AND-combined: only conversations carrying BOTH", async () => {
		const both = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
		});
		const onlyOne = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		const bothPlusExtra = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
		});
		await seedTag({ userId: "me", conversationId: both, name: "alfa" });
		await seedTag({ userId: "me", conversationId: both, name: "beta" });
		await seedTag({ userId: "me", conversationId: onlyOne, name: "alfa" });
		await seedTag({
			userId: "me",
			conversationId: bothPlusExtra,
			name: "alfa",
		});
		await seedTag({
			userId: "me",
			conversationId: bothPlusExtra,
			name: "beta",
		});
		await seedTag({
			userId: "me",
			conversationId: bothPlusExtra,
			name: "gamma",
		});

		const res = await caller(makeCtx(true)).list({
			filter: { tags: ["alfa", "beta"] },
		});
		// `onlyOne` (alfa only) is excluded; the extra tag on `bothPlusExtra` is harmless.
		expect(res.items.map((i) => i.id).sort()).toEqual(
			[both, bothPlusExtra].sort(),
		);
	});

	test("COUNT(DISTINCT name) guards against a duplicate tag row faking an AND match", async () => {
		// `dup` has TWO 'alfa' rows but no 'beta'. A COUNT(name)=2 (non-distinct) bug
		// would falsely match the two-tag AND; COUNT(DISTINCT name)=1 correctly excludes it.
		const dup = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedTag({
			userId: "me",
			conversationId: dup,
			name: "alfa",
			id: "d1",
		});
		await seedTag({
			userId: "me",
			conversationId: dup,
			name: "alfa",
			id: "d2",
		});

		const res = await caller(makeCtx(true)).list({
			filter: { tags: ["alfa", "beta"] },
		});
		expect(res.items).toHaveLength(0);
	});

	test("combines with the category filter (both active)", async () => {
		const pracaTagged = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			category: "praca",
		});
		const prywatneTagged = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			category: "prywatne",
		});
		const pracaUntagged = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			category: "praca",
		});
		await seedTag({ userId: "me", conversationId: pracaTagged, name: "alfa" });
		await seedTag({
			userId: "me",
			conversationId: prywatneTagged,
			name: "alfa",
		});
		// pracaUntagged has the category but not the tag.

		const res = await caller(makeCtx(true)).list({
			filter: { category: "praca", tags: ["alfa"] },
		});
		// Only the row matching BOTH category=praca AND tag=alfa survives.
		expect(res.items.map((i) => i.id)).toEqual([pracaTagged]);
		expect(res.items.map((i) => i.id)).not.toContain(prywatneTagged);
		expect(res.items.map((i) => i.id)).not.toContain(pracaUntagged);
	});

	test("an AND filter no conversation satisfies ⇒ empty page, null cursor", async () => {
		const onlyAlfa = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedTag({ userId: "me", conversationId: onlyAlfa, name: "alfa" });

		const res = await caller(makeCtx(true)).list({
			filter: { tags: ["alfa", "beta"] },
		});
		expect(res).toEqual({ items: [], nextCursor: null });
	});

	test("keyset pagination stays correct under an active tag filter", async () => {
		// 5 conversations carry "wspolny"; 2 distractors (no tag / different tag) must
		// never appear, and paging must walk only the filtered set with no overlap.
		const tagged: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			const id = await seedConversation({
				userId: "me",
				createdAt: at(`2026-06-10T10:0${i}:00.000Z`),
			});
			await seedTag({ userId: "me", conversationId: id, name: "wspolny" });
			tagged.push(id);
		}
		const distractorNoTag = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:06:00.000Z"),
		});
		const distractorOtherTag = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:07:00.000Z"),
		});
		await seedTag({
			userId: "me",
			conversationId: distractorOtherTag,
			name: "inny",
		});
		const newestFirst = [...tagged].reverse(); // seeded oldest→newest

		const p1 = await caller(makeCtx(true)).list({
			filter: { tags: ["wspolny"] },
			limit: 2,
		});
		expect(p1.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
		expect(p1.nextCursor).not.toBeNull();

		const p2 = await caller(makeCtx(true)).list({
			filter: { tags: ["wspolny"] },
			limit: 2,
			cursor: p1.nextCursor ?? undefined,
		});
		expect(p2.items.map((i) => i.id)).toEqual(newestFirst.slice(2, 4));
		expect(p2.nextCursor).not.toBeNull();

		const p3 = await caller(makeCtx(true)).list({
			filter: { tags: ["wspolny"] },
			limit: 2,
			cursor: p2.nextCursor ?? undefined,
		});
		expect(p3.items.map((i) => i.id)).toEqual(newestFirst.slice(4, 5));
		expect(p3.nextCursor).toBeNull();

		const seen = [
			...p1.items.map((i) => i.id),
			...p2.items.map((i) => i.id),
			...p3.items.map((i) => i.id),
		];
		expect(seen).toEqual(newestFirst);
		// The distractors never surfaced.
		expect(seen).not.toContain(distractorNoTag);
		expect(seen).not.toContain(distractorOtherTag);
	});

	test("normalizes raw filter input (defense-in-depth)", async () => {
		// A non-canonical tag from a stale client still narrows correctly because the
		// server runs `normalizeTags` over the input ("Pilne Zadanie" → "pilne-zadanie").
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedTag({ userId: "me", conversationId: id, name: "pilne-zadanie" });

		const res = await caller(makeCtx(true)).list({
			filter: { tags: ["Pilne Zadanie"] },
		});
		expect(res.items.map((i) => i.id)).toEqual([id]);
	});
});

describe("conversations.list — project filter", () => {
	test("a project id returns exactly that project's conversations", async () => {
		const alfa = await seedProject({ userId: "me", name: "Alfa" });
		const beta = await seedProject({ userId: "me", name: "Beta" });
		const inAlfa1 = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			projectId: alfa,
		});
		const inAlfa2 = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			projectId: alfa,
		});
		const inBeta = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:03.000Z"),
			projectId: beta,
		});
		const unassigned = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:04.000Z"),
			projectId: null,
		});

		const res = await caller(makeCtx(true)).list({
			filter: { projectId: alfa },
		});

		// Newest-first within the narrowed set; neither the other project's row nor
		// the unassigned one leaks in.
		expect(res.items.map((i) => i.id)).toEqual([inAlfa1, inAlfa2]);
		expect(res.items.map((i) => i.id)).not.toContain(inBeta);
		expect(res.items.map((i) => i.id)).not.toContain(unassigned);
	});

	test("the UNASSIGNED_PROJECT sentinel returns rows with project_id IS NULL", async () => {
		// The sentinel is the reason the filter is a string rather than a nullable
		// id: SQL `project_id = '__none__'` matches nothing, `IS NULL` matches the
		// class that is otherwise unreachable by any filter.
		const alfa = await seedProject({ userId: "me", name: "Alfa" });
		const assigned = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			projectId: alfa,
		});
		const unassigned1 = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			projectId: null,
		});
		const unassigned2 = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			projectId: null,
		});

		const res = await caller(makeCtx(true)).list({
			filter: { projectId: UNASSIGNED_PROJECT },
		});

		expect(res.items.map((i) => i.id)).toEqual([unassigned1, unassigned2]);
		expect(res.items.map((i) => i.id)).not.toContain(assigned);
	});

	test("an unknown project id yields an empty page, not an error", async () => {
		// Same contract as an unknown tag name: narrowing to nothing is a legitimate
		// answer, and a 500 here would turn a stale client into a broken panel.
		await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			projectId: null,
		});

		const res = await caller(makeCtx(true)).list({
			filter: { projectId: "p-does-not-exist" },
		});

		expect(res).toEqual({ items: [], nextCursor: null });
	});

	test("combines with the category AND tag filters (all three active)", async () => {
		const alfa = await seedProject({ userId: "me", name: "Alfa" });
		const beta = await seedProject({ userId: "me", name: "Beta" });
		// The only row satisfying project=alfa AND category=praca AND tag=pilne.
		const match = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:04.000Z"),
			projectId: alfa,
			category: "praca",
		});
		// Each of the three below fails exactly ONE of the three predicates, so a
		// dropped `and(...)` member surfaces as a specific extra row, not a wash.
		const wrongProject = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:03.000Z"),
			projectId: beta,
			category: "praca",
		});
		const wrongCategory = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			projectId: alfa,
			category: "prywatne",
		});
		const wrongTag = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			projectId: alfa,
			category: "praca",
		});
		await seedTag({ userId: "me", conversationId: match, name: "pilne" });
		await seedTag({
			userId: "me",
			conversationId: wrongProject,
			name: "pilne",
		});
		await seedTag({
			userId: "me",
			conversationId: wrongCategory,
			name: "pilne",
		});
		await seedTag({ userId: "me", conversationId: wrongTag, name: "inny" });

		const res = await caller(makeCtx(true)).list({
			filter: { projectId: alfa, category: "praca", tags: ["pilne"] },
		});

		expect(res.items.map((i) => i.id)).toEqual([match]);
	});

	test("keyset pagination stays correct under an active project filter", async () => {
		// The project predicate must sit in the SAME WHERE as the keyset, not be
		// applied to the fetched page — filtering post-fetch corrupts the cursor.
		const alfa = await seedProject({ userId: "me", name: "Alfa" });
		const inProject: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			inProject.push(
				await seedConversation({
					userId: "me",
					createdAt: at(`2026-06-10T10:0${i}:00.000Z`),
					projectId: alfa,
				}),
			);
		}
		// Interleaved chronologically, so a post-fetch filter would short the pages.
		const distractor = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:01:30.000Z"),
			projectId: null,
		});
		const newestFirst = [...inProject].reverse();

		const p1 = await caller(makeCtx(true)).list({
			filter: { projectId: alfa },
			limit: 2,
		});
		expect(p1.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
		const p2 = await caller(makeCtx(true)).list({
			filter: { projectId: alfa },
			limit: 2,
			cursor: p1.nextCursor ?? undefined,
		});
		expect(p2.items.map((i) => i.id)).toEqual(newestFirst.slice(2, 3));
		expect(p2.nextCursor).toBeNull();
		expect([...p1.items, ...p2.items].map((i) => i.id)).not.toContain(
			distractor,
		);
	});
});

describe("conversations.list — full-text search (FTS5, tag-vocabulary-control p2)", () => {
	// Every test here goes through `conversations.list`, NOT a raw MATCH: the
	// question is whether the router is WIRED to the index (phrase folded, quoted,
	// bound, AND-ed with the keyset), which a unit test of the pure builder cannot
	// answer. The index itself is maintained by the 0005 triggers, so the writes
	// below use the real write paths (`seedConversation` = INSERT, the
	// `updateTranscript` mutation = UPDATE, the `delete` mutation = DELETE).
	const seg = (text: string): TranscriptSegment => ({
		speaker: "Speaker A",
		text,
		startMs: 0,
	});

	async function idsFor(q: string): Promise<string[]> {
		const res = await caller(makeCtx(true)).list({ filter: { q } });
		return res.items.map((i) => i.id).sort();
	}

	test("2.5 after INSERT, a phrase from the transcript finds the conversation (and only it)", async () => {
		const hit = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("Oddzwonię w sprawie faktury za maj")],
		});
		await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			transcriptSegments: [seg("Umowa na remont łazienki")],
		});
		expect(await idsFor("faktury")).toEqual([hit]);
		// Prefix on the last token: "faktur" → "faktury".
		expect(await idsFor("faktur")).toEqual([hit]);
	});

	test("a phrase from the SUMMARY finds it too (summary is indexed alongside the transcript)", async () => {
		const hit = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("nic ciekawego")],
			analysis: analysisWith("Klient prosi o przedłużenie terminu"),
		});
		expect(await idsFor("przedłużenie terminu")).toEqual([hit]);
	});

	test("2.6 after UPDATE (updateTranscript), the old phrase no longer matches and the new one does", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("stara treść o gwarancji")],
		});
		expect(await idsFor("gwarancji")).toEqual([id]);

		await caller(makeCtx(true)).updateTranscript({
			conversationId: id,
			segments: [seg("nowa treść o reklamacji")],
		});
		expect(await idsFor("gwarancji")).toEqual([]);
		expect(await idsFor("reklamacji")).toEqual([id]);
		// DELETE-then-INSERT in the trigger: exactly ONE index row, not a stale
		// one plus a fresh one.
		const n = await client.execute({
			sql: `SELECT count(*) AS n FROM "memo-call_conversations_fts" WHERE conversation_id = ?`,
			args: [id],
		});
		expect(Number(n.rows[0]?.n)).toBe(1);
	});

	test("2.6b after an analysis UPDATE (worker/reanalyze shape), the new summary is searchable", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("rozmowa")],
			analysis: analysisWith("pierwsze podsumowanie"),
		});
		await db
			.update(conversations)
			.set({ analysis: analysisWith("drugie podsumowanie o podatkach") })
			.where(eq(conversations.id, id));
		expect(await idsFor("pierwsze")).toEqual([]);
		expect(await idsFor("podatkach")).toEqual([id]);
	});

	test("2.7 after DELETE, the phrase finds nothing and no orphan row remains in the index", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("temat do usunięcia: audyt")],
		});
		expect(await idsFor("audyt")).toEqual([id]);
		await caller(makeCtx(true)).delete({ id });
		expect(await idsFor("audyt")).toEqual([]);
		const n = await client.execute({
			sql: `SELECT count(*) AS n FROM "memo-call_conversations_fts" WHERE conversation_id = ?`,
			args: [id],
		});
		expect(Number(n.rows[0]?.n)).toBe(0);
	});

	test("2.8 ASCII queries find text stored with ł/ó/ż/ę (platnosc, dzial, zazolc)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [
				seg("Oddzwonię w sprawie płatności"),
				seg("Dział księgowości — Zażółć gęślą jaźń"),
			],
		});
		expect(await idsFor("platnosc")).toEqual([id]);
		expect(await idsFor("dzial")).toEqual([id]);
		expect(await idsFor("zazolc")).toEqual([id]);
		expect(await idsFor("gesla")).toEqual([id]);
	});

	test("2.9 symmetry, the other direction: a phrase typed WITH Polish letters returns the SAME set as its ASCII twin", async () => {
		// This is the failure mode measured during planning: the trigger folds `ł`
		// at index time, so `MATCH 'płatność'` is 0 rows unless the QUERY is folded
		// too. It passes only if the router actually calls the folder — which is
		// why this goes through `list`, not through a raw MATCH.
		const a = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("Zaległe płatności za dział techniczny")],
		});
		const b = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			transcriptSegments: [seg("Płatność gotówką w dziale sprzedaży")],
		});
		await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:03.000Z"),
			transcriptSegments: [seg("Coś zupełnie innego")],
		});
		for (const [polish, ascii] of [
			["płatność", "platnosc"],
			["dział", "dzial"],
			["Płatności dział", "platnosci dzial"],
		]) {
			const viaPolish = await idsFor(polish as string);
			const viaAscii = await idsFor(ascii as string);
			expect(viaPolish, `${polish} vs ${ascii}`).toEqual(viaAscii);
			expect(viaPolish.length, `${polish} should hit`).toBeGreaterThan(0);
		}
		expect(await idsFor("płatność")).toEqual([a, b].sort());
		expect(await idsFor("dział")).toEqual([a, b].sort());
	});

	test("2.10 FTS5 syntax characters never break the query — a result or an empty page, never a throw", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("faktura za umowę")],
		});
		// Each of these would be a syntax error if it reached the FTS5 parser raw.
		for (const q of [
			'"faktur',
			'faktura"',
			"faktura*",
			"*faktura",
			"faktura OR",
			"OR faktura",
			"NEAR(faktura umowa)",
			"body:faktura",
			"-faktura",
			"^faktura",
			"faktura -umowa",
			"(faktura",
			"faktura)",
			"faktura AND umowę",
		]) {
			const items = await idsFor(q);
			expect(Array.isArray(items), q).toBe(true);
		}
		// And the readable ones still find the row.
		expect(await idsFor('"faktur')).toEqual([id]);
		expect(await idsFor("faktura umowę")).toEqual([id]);
		// An operator word is a LITERAL token, AND-ed like any other: "and" does
		// not occur in the body, so this is an honest empty page, not a boolean.
		expect(await idsFor("faktura AND umowę")).toEqual([]);
		// Pure syntax with no token: matches NOTHING (not "everything").
		expect(await idsFor("--")).toEqual([]);
		expect(await idsFor("**")).toEqual([]);
		// 18 `list` calls × the dev-only 100–500 ms `timingMiddleware` delay
		// (`~/server/api/trpc`) — that delay, not FTS5, is what blows the default
		// 5 s budget.
	}, 30_000);

	test("2.11 JSON metadata (speaker, startMs) is NOT searchable — with the positive control in the same test", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [
				{ speaker: "Speaker A", text: "ustalenia projektowe", startMs: 0 },
			],
		});
		// Positive control FIRST: the index is live for this row. Without it the
		// two absence assertions below are green over an empty index too.
		expect(await idsFor("ustalenia")).toEqual([id]);
		expect(await idsFor("speaker")).toEqual([]);
		expect(await idsFor("startms")).toEqual([]);
		expect(await idsFor("startMs")).toEqual([]);
	});

	test("2.13 phrase AND category AND project AND tags narrow together", async () => {
		const alfa = await seedProject({ userId: "me", name: "Alfa" });
		const beta = await seedProject({ userId: "me", name: "Beta" });
		const match = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			category: "praca",
			projectId: alfa,
			transcriptSegments: [seg("faktura korygująca")],
		});
		await seedTag({ userId: "me", conversationId: match, name: "faktury" });
		const wrongPhrase = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			category: "praca",
			projectId: alfa,
			transcriptSegments: [seg("umowa najmu")],
		});
		await seedTag({
			userId: "me",
			conversationId: wrongPhrase,
			name: "faktury",
		});
		const wrongProject = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:03.000Z"),
			category: "praca",
			projectId: beta,
			transcriptSegments: [seg("faktura korygująca")],
		});
		await seedTag({
			userId: "me",
			conversationId: wrongProject,
			name: "faktury",
		});
		const wrongCategory = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:04.000Z"),
			category: "prywatne",
			projectId: alfa,
			transcriptSegments: [seg("faktura korygująca")],
		});
		await seedTag({
			userId: "me",
			conversationId: wrongCategory,
			name: "faktury",
		});
		const wrongTag = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:05.000Z"),
			category: "praca",
			projectId: alfa,
			transcriptSegments: [seg("faktura korygująca")],
		});
		await seedTag({ userId: "me", conversationId: wrongTag, name: "umowy" });

		const res = await caller(makeCtx(true)).list({
			filter: {
				q: "faktura",
				category: "praca",
				projectId: alfa,
				tags: ["faktury"],
			},
		});
		expect(res.items.map((i) => i.id)).toEqual([match]);
		// Sanity: the phrase alone matches four of the five.
		expect((await idsFor("faktura")).length).toBe(4);
	});

	test("keyset pagination stays correct under an active phrase", async () => {
		const hits: string[] = [];
		for (let i = 0; i < 5; i++) {
			hits.push(
				await seedConversation({
					userId: "me",
					createdAt: at(`2026-06-10T10:00:0${i}.000Z`),
					transcriptSegments: [seg(`rozmowa numer ${i} o rekrutacji`)],
				}),
			);
		}
		await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:09.000Z"),
			transcriptSegments: [seg("nie o tym")],
		});
		const c = caller(makeCtx(true));
		const p1 = await c.list({ filter: { q: "rekrutacji" }, limit: 2 });
		expect(p1.items.map((i) => i.id)).toEqual([hits[4], hits[3]]);
		expect(p1.nextCursor).not.toBeNull();
		const p2 = await c.list({
			filter: { q: "rekrutacji" },
			limit: 2,
			cursor: p1.nextCursor as string,
		});
		expect(p2.items.map((i) => i.id)).toEqual([hits[2], hits[1]]);
		const p3 = await c.list({
			filter: { q: "rekrutacji" },
			limit: 2,
			cursor: p2.nextCursor as string,
		});
		expect(p3.items.map((i) => i.id)).toEqual([hits[0]]);
		expect(p3.nextCursor).toBeNull();
	});

	test("a phrase shorter than SEARCH_MIN_CHARS is rejected at the input boundary", async () => {
		await expect(
			caller(makeCtx(true)).list({ filter: { q: "a" } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Trim runs before the length check: two spaces around one letter is "a".
		await expect(
			caller(makeCtx(true)).list({ filter: { q: " a " } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("a phrase longer than SEARCH_MAX_CHARS is rejected at the input boundary (CPU sink guard)", async () => {
		await expect(
			caller(makeCtx(true)).list({ filter: { q: "a".repeat(201) } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// Exactly at the limit is fine.
		const res = await caller(makeCtx(true)).list({
			filter: { q: "a".repeat(200) },
		});
		expect(res.items).toEqual([]);
	});

	test("user scoping holds under search: another user's matching conversation never appears", async () => {
		const mine = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("poufne ustalenia")],
		});
		await seedConversation({
			userId: "other",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			transcriptSegments: [seg("poufne ustalenia")],
		});
		expect(await idsFor("poufne")).toEqual([mine]);
	});

	test("2.15 data safety: a full write cycle on conversation A leaves EVERY row of conversation B untouched", async () => {
		const a = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			transcriptSegments: [seg("A pierwsza wersja")],
			analysis: analysisWith("A podsumowanie 1"),
		});
		const b = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:02.000Z"),
			transcriptSegments: [seg("B treść stała")],
			analysis: analysisWith("B podsumowanie stałe"),
		});
		await seedTag({ userId: "me", conversationId: b, name: "stale" });

		const snapshotB = async () => ({
			conv: (
				await client.execute({
					sql: `SELECT * FROM "memo-call_conversations" WHERE id = ?`,
					args: [b],
				})
			).rows,
			tags: (
				await client.execute({
					sql: `SELECT * FROM "memo-call_tags" WHERE conversation_id = ? ORDER BY id`,
					args: [b],
				})
			).rows,
			fts: (
				await client.execute({
					sql: `SELECT body, conversation_id FROM "memo-call_conversations_fts" WHERE conversation_id = ?`,
					args: [b],
				})
			).rows,
		});
		const before = await snapshotB();

		// INSERT (done above) → UPDATE transcript → UPDATE analysis on A.
		await caller(makeCtx(true)).updateTranscript({
			conversationId: a,
			segments: [seg("A druga wersja")],
		});
		await db
			.update(conversations)
			.set({ analysis: analysisWith("A podsumowanie 2") })
			.where(eq(conversations.id, a));

		expect(await snapshotB()).toEqual(before);
		expect(await idsFor("stała")).toEqual([b]);
		expect(await idsFor("druga")).toEqual([a]);
	});
});

describe("conversations.list — not gated + status derivation", () => {
	test("analysis present ⇒ done", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: analysisWith("Zrobione."),
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "done",
			updatedAt: at("2026-06-10T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items).toHaveLength(1);
		expect(res.items[0]?.status).toBe("done");
		expect(res.items[0]?.summary).toBe("Zrobione.");
	});

	test("NULL analysis + failed job ⇒ returned with status 'failed' (not gated)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: null,
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "failed",
			updatedAt: at("2026-06-10T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items.map((i) => i.id)).toEqual([id]);
		expect(res.items[0]?.status).toBe("failed");
		expect(res.items[0]?.summary).toBeNull();
	});

	test("NULL analysis + in-progress job ⇒ returned with status 'in_progress'", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: null,
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "transcribing",
			updatedAt: at("2026-06-10T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items.map((i) => i.id)).toEqual([id]);
		expect(res.items[0]?.status).toBe("in_progress");
	});

	test("NULL analysis + NO job ⇒ returned with status 'in_progress' (default branch)", async () => {
		// The most common runtime state and the ternary's fall-through: a row with
		// no job at all must still list (not vanish) and derive to in_progress.
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: null,
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items.map((i) => i.id)).toEqual([id]);
		expect(res.items[0]?.status).toBe("in_progress");
		expect(res.items[0]?.summary).toBeNull();
	});

	test("multiple jobs for one conversation ⇒ exactly ONE row, latest status (no fan-out)", async () => {
		// A state the app can't produce (ingress is idempotent, replay mutates in
		// place), seeded directly to prove the two-query design doesn't fan out.
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: null,
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "pending",
			updatedAt: at("2026-06-10T10:01:00.000Z"),
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "failed",
			updatedAt: at("2026-06-10T10:09:00.000Z"), // latest
		});

		const res = await caller(makeCtx(true)).list({});
		// One display row despite two job rows, status = the latest job's.
		expect(res.items).toHaveLength(1);
		expect(res.items[0]?.id).toBe(id);
		expect(res.items[0]?.status).toBe("failed");
	});
});

describe("conversations.list — project label", () => {
	test("returns the joined project name for the owner", async () => {
		const projectId = await seedProject({ userId: "me", name: "Alpha" });
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			projectId,
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items.map((i) => i.id)).toEqual([id]);
		expect(res.items[0]?.projectName).toBe("Alpha");
	});

	test("does NOT leak another user's project name through the join", async () => {
		// FK allows a 'me' conversation to reference any project row; the join is
		// scoped on projects.userId, so an 'other'-owned project must not surface.
		const otherProject = await seedProject({ userId: "other", name: "Beta" });
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			projectId: otherProject,
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items.map((i) => i.id)).toEqual([id]);
		expect(res.items[0]?.projectName).toBeNull();
	});
});

describe("conversations.list — empty + pagination", () => {
	test("empty database ⇒ { items: [], nextCursor: null }", async () => {
		const res = await caller(makeCtx(true)).list({});
		expect(res).toEqual({ items: [], nextCursor: null });
	});

	test("pages through > limit rows with no overlap and a null final cursor", async () => {
		// 5 rows, strictly descending so order is unambiguous; page size 2.
		const ids: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			ids.push(
				await seedConversation({
					userId: "me",
					createdAt: at(`2026-06-10T10:0${i}:00.000Z`),
				}),
			);
		}
		const newestFirst = [...ids].reverse(); // seeded oldest→newest

		const p1 = await caller(makeCtx(true)).list({ limit: 2 });
		expect(p1.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
		expect(p1.nextCursor).not.toBeNull();

		const p2 = await caller(makeCtx(true)).list({
			limit: 2,
			cursor: p1.nextCursor ?? undefined,
		});
		expect(p2.items.map((i) => i.id)).toEqual(newestFirst.slice(2, 4));
		expect(p2.nextCursor).not.toBeNull();

		const p3 = await caller(makeCtx(true)).list({
			limit: 2,
			cursor: p2.nextCursor ?? undefined,
		});
		expect(p3.items.map((i) => i.id)).toEqual(newestFirst.slice(4, 5));
		expect(p3.nextCursor).toBeNull();

		// Union of all pages == every row, exactly once.
		const seen = [
			...p1.items.map((i) => i.id),
			...p2.items.map((i) => i.id),
			...p3.items.map((i) => i.id),
		];
		expect(seen).toEqual(newestFirst);
		expect(new Set(seen).size).toBe(5);
	});

	test("a malformed cursor is rejected with BAD_REQUEST", async () => {
		await expect(
			caller(makeCtx(true)).list({ cursor: "not-a-valid-cursor" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("conversations.list — auth gate", () => {
	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(caller(makeCtx(false)).list({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

describe("conversations.list — override flags (S-03)", () => {
	test("surfaces categoryOverridden/projectOverridden on each row", async () => {
		await seedConversation({
			id: "c-auto",
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await seedConversation({
			id: "c-manual",
			userId: "me",
			createdAt: at("2026-06-10T10:00:01.000Z"),
			categoryOverridden: true,
			projectOverridden: true,
		});

		const res = await caller(makeCtx(true)).list({});
		const byId = new Map(res.items.map((i) => [i.id, i]));
		expect(byId.get("c-auto")?.categoryOverridden).toBe(false);
		expect(byId.get("c-auto")?.projectOverridden).toBe(false);
		expect(byId.get("c-manual")?.categoryOverridden).toBe(true);
		expect(byId.get("c-manual")?.projectOverridden).toBe(true);
	});
});

describe("conversations.getById (S-03)", () => {
	test("returns the full detail contract for the owner", async () => {
		const projectId = await seedProject({
			userId: "me",
			name: "Alpha",
			category: "praca",
		});
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			category: "praca",
			projectId,
			analysis: analysisWith("Szczegóły."),
			transcriptSegments: [
				{ speaker: "Speaker A", text: "Dzień dobry.", startMs: 0, endMs: 1000 },
			],
			transcriptLanguage: "pl-PL",
			durationMs: 1000,
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "done",
			updatedAt: at("2026-06-10T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.id).toBe(id);
		expect(res.category).toBe("praca");
		expect(res.projectId).toBe(projectId);
		expect(res.projectName).toBe("Alpha");
		expect(res.categoryOverridden).toBe(false);
		expect(res.projectOverridden).toBe(false);
		expect(res.analysis?.summary).toBe("Szczegóły.");
		expect(res.transcriptSegments?.[0]?.text).toBe("Dzień dobry.");
		expect(res.transcriptLanguage).toBe("pl-PL");
		expect(res.durationMs).toBe(1000);
		expect(res.status).toBe("done");
	});

	test("returns the conversation's tag rows (S-05), ordered (createdAt, name)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		// Seeded out of final order: same createdAt → name asc tie-break ("a" < "z");
		// the later createdAt row sorts last regardless of name.
		await db.insert(tags).values({
			id: "tg-z",
			userId: "me",
			conversationId: id,
			name: "zebra",
			isUserEdited: false,
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await db.insert(tags).values({
			id: "tg-a",
			userId: "me",
			conversationId: id,
			name: "alfa",
			isUserEdited: true,
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await db.insert(tags).values({
			id: "tg-later",
			userId: "me",
			conversationId: id,
			name: "aaa-but-later",
			isUserEdited: false,
			createdAt: at("2026-06-10T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.tags).toEqual([
			{ id: "tg-a", name: "alfa", isUserEdited: true },
			{ id: "tg-z", name: "zebra", isUserEdited: false },
			{ id: "tg-later", name: "aaa-but-later", isUserEdited: false },
		]);
		// The conversation-level "user-edited" indicator is derived from the rows.
		expect(res.tags.some((t) => t.isUserEdited)).toBe(true);
	});

	test("returns an empty tags array when the conversation has none", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.tags).toEqual([]);
	});

	test("derives status from the latest job when analysis is NULL (failed)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: null,
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "failed",
			updatedAt: at("2026-06-10T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.status).toBe("failed");
	});

	test("does NOT leak another user's project name through the join", async () => {
		const otherProject = await seedProject({ userId: "other", name: "Beta" });
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			projectId: otherProject,
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.projectName).toBeNull();
	});

	test("NOT_FOUND for a foreign id", async () => {
		const otherId = await seedConversation({
			userId: "other",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await expect(
			caller(makeCtx(true)).getById({ id: otherId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).getById({ id: "whatever" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("conversations.overrideClassification (S-03 / FR-016)", () => {
	test("rejects a project whose category ≠ chosen category (BAD_REQUEST), persists nothing", async () => {
		const prywatneProject = await seedProject({
			userId: "me",
			name: "Dom",
			category: "prywatne",
		});
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});

		await expect(
			caller(makeCtx(true)).overrideClassification({
				conversationId: id,
				category: "praca", // mismatch: the project is prywatne
				projectId: prywatneProject,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const after = await caller(makeCtx(true)).getById({ id });
		expect(after.category).toBeNull();
		expect(after.categoryOverridden).toBe(false);
		expect(after.projectOverridden).toBe(false);
	});

	test("sets both *_overridden flags and persists category + projectId", async () => {
		const pracaProject = await seedProject({
			userId: "me",
			name: "Klient X",
			category: "praca",
		});
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			analysis: analysisWith("Nienaruszone."),
		});

		const res = await caller(makeCtx(true)).overrideClassification({
			conversationId: id,
			category: "praca",
			projectId: pracaProject,
		});
		expect(res).toEqual({ ok: true });

		const after = await caller(makeCtx(true)).getById({ id });
		expect(after.category).toBe("praca");
		expect(after.projectId).toBe(pracaProject);
		expect(after.categoryOverridden).toBe(true);
		expect(after.projectOverridden).toBe(true);
		// Override touches ONLY the classification pair — analysis is untouched.
		// Guards against a future field creeping into the .set().
		expect(after.analysis?.summary).toBe("Nienaruszone.");
	});

	test("allows clearing the project (projectId: null) while setting a category", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});

		await caller(makeCtx(true)).overrideClassification({
			conversationId: id,
			category: "prywatne",
			projectId: null,
		});

		const after = await caller(makeCtx(true)).getById({ id });
		expect(after.category).toBe("prywatne");
		expect(after.projectId).toBeNull();
		expect(after.categoryOverridden).toBe(true);
		expect(after.projectOverridden).toBe(true);
	});

	test("rejects an unknown / foreign-owned project (NOT_FOUND)", async () => {
		const otherProject = await seedProject({
			userId: "other",
			name: "Obcy",
			category: "praca",
		});
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});

		await expect(
			caller(makeCtx(true)).overrideClassification({
				conversationId: id,
				category: "praca",
				projectId: otherProject,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an override on a foreign conversation (NOT_FOUND)", async () => {
		const otherConv = await seedConversation({
			userId: "other",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});

		await expect(
			caller(makeCtx(true)).overrideClassification({
				conversationId: otherConv,
				category: "praca",
				projectId: null,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).overrideClassification({
				conversationId: "whatever",
				category: "praca",
				projectId: null,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("conversations.delete", () => {
	test("deletes the row (getById ⇒ NOT_FOUND afterward)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});

		const res = await caller(makeCtx(true)).delete({ id });
		expect(res).toEqual({ ok: true });

		await expect(caller(makeCtx(true)).getById({ id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const rows = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.id, id));
		expect(rows).toHaveLength(0);
	});

	test("cascades to tags, transcript_edits, and processing_jobs (FK ON DELETE CASCADE)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await db.insert(tags).values({
			id: "t-1",
			userId: "me",
			conversationId: id,
			name: "ważne",
		});
		await db.insert(transcriptEdits).values({
			id: "te-1",
			userId: "me",
			conversationId: id,
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "done",
			updatedAt: at("2026-06-10T10:05:00.000Z"),
		});

		await caller(makeCtx(true)).delete({ id });

		// Real cascade (not a stub) — the whole reason this is an integration test.
		const remainingTags = await db
			.select({ id: tags.id })
			.from(tags)
			.where(eq(tags.conversationId, id));
		const remainingEdits = await db
			.select({ id: transcriptEdits.id })
			.from(transcriptEdits)
			.where(eq(transcriptEdits.conversationId, id));
		const remainingJobs = await db
			.select({ id: processingJobs.id })
			.from(processingJobs)
			.where(eq(processingJobs.conversationId, id));
		expect(remainingTags).toHaveLength(0);
		expect(remainingEdits).toHaveLength(0);
		expect(remainingJobs).toHaveLength(0);
	});

	test("NOT_FOUND for an unknown id", async () => {
		await expect(
			caller(makeCtx(true)).delete({ id: "does-not-exist" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("NOT_FOUND for a foreign conversation, row preserved", async () => {
		const otherId = await seedConversation({
			userId: "other",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});

		await expect(
			caller(makeCtx(true)).delete({ id: otherId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// The cross-user row must survive (the WHERE is scoped on userId).
		const rows = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.id, otherId));
		expect(rows).toHaveLength(1);
	});

	test("deletes the resident recording at the provider before the row (FR-002 guard)", async () => {
		// recordingSid set + recordingDeletedAt NULL ⇒ a recording is still resident,
		// so the cleanup branch must fire. The mock's deleteRecording is a no-op, so
		// without this spy nothing would catch a dropped call or an inverted guard.
		await db.insert(conversations).values({
			id: "c-rec",
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			recordingSid: "RE-resident",
			recordingDeletedAt: null,
		});
		const spy = vi.spyOn(telephony, "deleteRecording");

		try {
			await caller(makeCtx(true)).delete({ id: "c-rec" });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith({ recordingSid: "RE-resident" });
		} finally {
			spy.mockRestore();
		}
	});

	test("does NOT re-delete a recording already deleted (recordingDeletedAt set)", async () => {
		await db.insert(conversations).values({
			id: "c-rec-gone",
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			recordingSid: "RE-gone",
			recordingDeletedAt: at("2026-06-10T10:06:00.000Z"),
		});
		const spy = vi.spyOn(telephony, "deleteRecording");

		try {
			await caller(makeCtx(true)).delete({ id: "c-rec-gone" });
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	test("buries the call_sid so capture reconciliation can never resurrect it", async () => {
		// impl-review phase 2, F1. The provider delete is BEST-EFFORT: when it
		// throws, the row is deleted anyway. That leaves a recording resident at
		// the provider with no `conversations` row — byte-for-byte the state
		// `runReconcileSweep` treats as a lost note. Without the tombstone the
		// deleted note reappears within five minutes and its audio is sent to STT
		// + LLM a second time.
		await db.insert(conversations).values({
			id: "c-buried",
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
			callSid: "out_buried_call",
			recordingSid: "RE-still-there",
			recordingDeletedAt: null,
		});
		const spy = vi
			.spyOn(telephony, "deleteRecording")
			.mockRejectedValue(new Error("provider down"));

		try {
			await caller(makeCtx(true)).delete({ id: "c-buried" });
		} finally {
			spy.mockRestore();
		}

		// Row gone (the delete is not blocked by the provider failure) …
		const rows = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.id, "c-buried"));
		expect(rows).toHaveLength(0);
		// … and the call is on the do-not-resurrect list.
		const buried = await client.execute(
			'SELECT user_id, call_sid FROM "memo-call_reconcile_tombstones"',
		);
		expect(buried.rows).toHaveLength(1);
		expect(buried.rows[0]?.call_sid).toBe("out_buried_call");
		expect(buried.rows[0]?.user_id).toBe("me");
	});

	test("a conversation with no call_sid buries nothing (nullable column)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-10T10:00:00.000Z"),
		});
		await caller(makeCtx(true)).delete({ id });

		const buried = await client.execute(
			'SELECT call_sid FROM "memo-call_reconcile_tombstones"',
		);
		expect(buried.rows).toHaveLength(0);
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).delete({ id: "whatever" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

const SEG: TranscriptSegment[] = [
	{ speaker: "Speaker A", text: "Dzień dobry.", startMs: 0, endMs: 2000 },
	{ speaker: "Speaker B", text: "Witam.", startMs: 2000, endMs: 4000 },
];

describe("conversations.updateTranscript (FR-020)", () => {
	test("persists edited segments, stamps transcriptEditedAt, inserts an audit row", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			transcriptSegments: [{ speaker: "Speaker A", text: "stare" }],
		});

		const res = await caller(makeCtx(true)).updateTranscript({
			conversationId: id,
			segments: SEG,
		});
		expect(res).toEqual({ ok: true });

		const [conv] = await db
			.select({
				transcriptSegments: conversations.transcriptSegments,
				transcriptEditedAt: conversations.transcriptEditedAt,
			})
			.from(conversations)
			.where(eq(conversations.id, id));
		expect(conv?.transcriptSegments).toEqual(SEG);
		expect(conv?.transcriptEditedAt).not.toBeNull();

		// Exactly one append-only audit row landed for this conversation.
		const edits = await db
			.select({ id: transcriptEdits.id })
			.from(transcriptEdits)
			.where(eq(transcriptEdits.conversationId, id));
		expect(edits).toHaveLength(1);
	});

	test("empty segments → BAD_REQUEST (zod .min(1))", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
		});
		await expect(
			caller(makeCtx(true)).updateTranscript({
				conversationId: id,
				segments: [],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("a foreign/unknown conversation id → NOT_FOUND (no cross-user write)", async () => {
		const otherId = await seedConversation({
			userId: "other",
			createdAt: at("2026-06-20T10:00:00.000Z"),
		});
		await expect(
			caller(makeCtx(true)).updateTranscript({
				conversationId: otherId,
				segments: SEG,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).updateTranscript({
				conversationId: "whatever",
				segments: SEG,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("conversations.reanalyze (FR-021)", () => {
	test("enqueues a kind='reanalyze' pending job and calls the injected onReanalyze", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			transcriptSegments: SEG,
		});
		const onReanalyze = vi.fn();

		const res = await caller(makeCtx(true), { onReanalyze }).reanalyze({
			conversationId: id,
		});
		expect(res).toEqual({ ok: true });

		const jobs = await db
			.select({
				id: processingJobs.id,
				status: processingJobs.status,
				kind: processingJobs.kind,
			})
			.from(processingJobs)
			.where(eq(processingJobs.conversationId, id));
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.status).toBe("pending");
		expect(jobs[0]?.kind).toBe("reanalyze");

		// The kickoff seam fired exactly once, with the enqueued job id.
		expect(onReanalyze).toHaveBeenCalledTimes(1);
		expect(onReanalyze).toHaveBeenCalledWith(jobs[0]?.id, expect.anything());
	});

	test("a conversation with no transcript → BAD_REQUEST (nothing to re-analyze)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			transcriptSegments: null,
		});
		const onReanalyze = vi.fn();
		await expect(
			caller(makeCtx(true), { onReanalyze }).reanalyze({ conversationId: id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(onReanalyze).not.toHaveBeenCalled();
	});

	test("a second reanalyze while one is in-flight → CONFLICT (no duplicate job)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			transcriptSegments: SEG,
		});
		// Pre-seed an in-flight reanalyze job.
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "analyzing",
			updatedAt: at("2026-06-20T10:01:00.000Z"),
			kind: "reanalyze",
		});
		const onReanalyze = vi.fn();
		await expect(
			caller(makeCtx(true), { onReanalyze }).reanalyze({ conversationId: id }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(onReanalyze).not.toHaveBeenCalled();
		// No second job was inserted.
		const jobs = await db
			.select({ id: processingJobs.id })
			.from(processingJobs)
			.where(eq(processingJobs.conversationId, id));
		expect(jobs).toHaveLength(1);
	});

	test("a foreign/unknown conversation id → NOT_FOUND", async () => {
		const otherId = await seedConversation({
			userId: "other",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			transcriptSegments: SEG,
		});
		await expect(
			caller(makeCtx(true)).reanalyze({ conversationId: otherId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).reanalyze({ conversationId: "whatever" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("conversations.getById — reanalyze signals", () => {
	test("reanalyzing=true while a reanalyze job is pending/analyzing (analysis still shown)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			analysis: analysisWith("istniejąca analiza"),
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "analyzing",
			updatedAt: at("2026-06-20T10:05:00.000Z"),
			kind: "reanalyze",
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.reanalyzing).toBe(true);
		expect(res.lastReanalyzeFailed).toBe(false);
		// The prior analysis stays visible throughout (status keys on analysis presence).
		expect(res.status).toBe("done");
		expect(res.analysis?.summary).toBe("istniejąca analiza");
	});

	test("lastReanalyzeFailed=true when the latest reanalyze job failed but analysis persists", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			analysis: analysisWith("poprzednia analiza"),
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "failed",
			updatedAt: at("2026-06-20T10:05:00.000Z"),
			kind: "reanalyze",
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.lastReanalyzeFailed).toBe(true);
		expect(res.reanalyzing).toBe(false);
		// Non-destructive: the prior analysis was NOT clobbered by the failed re-analyze.
		expect(res.status).toBe("done");
		expect(res.analysis?.summary).toBe("poprzednia analiza");
	});

	test("neither signal set for a plain done conversation (no reanalyze job)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-06-20T10:00:00.000Z"),
			analysis: analysisWith("zwykła analiza"),
		});
		await seedJob({
			userId: "me",
			conversationId: id,
			status: "done",
			updatedAt: at("2026-06-20T10:05:00.000Z"),
		});

		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.reanalyzing).toBe(false);
		expect(res.lastReanalyzeFailed).toBe(false);
	});
});

/**
 * FR-025 (`caller-identity-in-archive`, phase 4): the counterparty in every
 * row, the by-value contact join, the contact filter, and the label mutation.
 * Numbers here are PLACEHOLDERS (the file is in git and in every CI diff);
 * their only job is to be greppable in the "nothing reaches the log" checks.
 */
const CP_NUMBER = "+48512345678";
const CP_HINT = "Zenobia Testowa";
const CP_FOREIGN = "+14155550100";

describe("conversations.list — counterparty (FR-025)", () => {
	test("a pre-FR-025 row (state NULL) carries counterparty: null", async () => {
		await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
		});
		const res = await caller(makeCtx(true)).list({});
		expect(res.items[0]?.counterparty).toBeNull();
	});

	test("known + a contact holding the number ⇒ every field, contact name joined by value", async () => {
		const contactId = await seedContact({
			userId: "me",
			name: "Zenobia (księgowa)",
			e164: CP_NUMBER,
		});
		await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
			counterpartyNameHint: CP_HINT,
		});
		const res = await caller(makeCtx(true)).list({});
		// The server returns EVERYTHING; the panel decides the precedence.
		expect(res.items[0]?.counterparty).toEqual({
			state: "known",
			e164: CP_NUMBER,
			nameHint: CP_HINT,
			contactId,
			contactName: "Zenobia (księgowa)",
		});
	});

	test("known without a contact ⇒ contactId/contactName null, number + hint kept", async () => {
		await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
			counterpartyNameHint: CP_HINT,
		});
		const res = await caller(makeCtx(true)).list({});
		expect(res.items[0]?.counterparty).toEqual({
			state: "known",
			e164: CP_NUMBER,
			nameHint: CP_HINT,
			contactId: null,
			contactName: null,
		});
	});

	test.each([
		"pending",
		"withheld",
		"unavailable",
	] as const)("state %s ⇒ passed through with a null number", async (state) => {
		await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: state,
		});
		const res = await caller(makeCtx(true)).list({});
		expect(res.items[0]?.counterparty).toEqual({
			state,
			e164: null,
			nameHint: null,
			contactId: null,
			contactName: null,
		});
	});

	test("the user predicate sits in the join ON: unlabeled rows survive, a foreign contact never labels", async () => {
		// A WHERE-placed `contacts.user_id = 'me'` would (a) drop `unlabeled`
		// (all-NULL right side ⇒ NULL = 'me') and (b) is irrelevant to (c). The
		// ON-placed one keeps (a) and hides the `other` user's contact in (c).
		await seedContact({ userId: "other", name: "Obcy", e164: CP_NUMBER });
		const labeledByNobody = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:02.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const unlabeled = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:01.000Z"),
			counterpartyState: "withheld",
		});
		const preFr025 = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
		});

		const res = await caller(makeCtx(true)).list({});
		expect(res.items.map((i) => i.id)).toEqual([
			labeledByNobody,
			unlabeled,
			preFr025,
		]);
		expect(res.items[0]?.counterparty?.contactName).toBeNull();
		expect(res.items[0]?.counterparty?.contactId).toBeNull();
	});

	test("two conversations with one number + one contact ⇒ no fan-out, keyset by 1 walks both exactly once", async () => {
		await seedContact({ userId: "me", name: "Zenobia", e164: CP_NUMBER });
		const a = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:01.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const b = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const c = caller(makeCtx(true));
		const p1 = await c.list({ limit: 1 });
		expect(p1.items.map((i) => i.id)).toEqual([a]);
		expect(p1.items[0]?.counterparty?.contactName).toBe("Zenobia");
		expect(p1.nextCursor).not.toBeNull();
		const p2 = await c.list({ limit: 1, cursor: p1.nextCursor as string });
		expect(p2.items.map((i) => i.id)).toEqual([b]);
		expect(p2.items[0]?.counterparty?.contactName).toBe("Zenobia");
		expect(p2.nextCursor).toBeNull();
	});
});

describe("conversations.list — contact filter (FR-025)", () => {
	test("narrows to conversations whose number the contact holds", async () => {
		const zenobia = await seedContact({
			userId: "me",
			name: "Zenobia",
			e164: CP_NUMBER,
		});
		const withZenobia1 = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:03.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const withZenobia2 = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:02.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const withSomeoneElse = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:01.000Z"),
			counterpartyState: "known",
			counterpartyE164: "+48512345679",
		});
		const withheld = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "withheld",
		});

		const res = await caller(makeCtx(true)).list({
			filter: { contactId: zenobia },
		});
		expect(res.items.map((i) => i.id)).toEqual([withZenobia1, withZenobia2]);
		expect(res.items.map((i) => i.id)).not.toContain(withSomeoneElse);
		expect(res.items.map((i) => i.id)).not.toContain(withheld);
	});

	test.each([
		{
			name: "a contact with no number",
			seed: () => seedContact({ userId: "me", name: "Bez numeru" }),
		},
		{ name: "an unknown contact id", seed: async () => "ct-does-not-exist" },
		{
			name: "another user's contact",
			seed: () =>
				seedContact({ userId: "other", name: "Obcy", e164: CP_NUMBER }),
		},
	])("$name ⇒ empty page, not an error", async ({ seed }) => {
		await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const contactId = await seed();
		const res = await caller(makeCtx(true)).list({
			filter: { contactId },
		});
		expect(res).toEqual({ items: [], nextCursor: null });
	});

	test("combines with the other filters and keeps the keyset correct", async () => {
		const zenobia = await seedContact({
			userId: "me",
			name: "Zenobia",
			e164: CP_NUMBER,
		});
		const hits: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			hits.push(
				await seedConversation({
					userId: "me",
					createdAt: at(`2026-10-19T10:0${i}:00.000Z`),
					category: "praca",
					counterpartyState: "known",
					counterpartyE164: CP_NUMBER,
				}),
			);
		}
		// Interleaved: same contact, wrong category — a post-fetch filter would
		// short a page; the SQL predicate must not.
		const wrongCategory = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:01:30.000Z"),
			category: "prywatne",
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const newestFirst = [...hits].reverse();
		const c = caller(makeCtx(true));
		const filter = { contactId: zenobia, category: "praca" as const };
		const p1 = await c.list({ filter, limit: 2 });
		expect(p1.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
		const p2 = await c.list({
			filter,
			limit: 2,
			cursor: p1.nextCursor as string,
		});
		expect(p2.items.map((i) => i.id)).toEqual(newestFirst.slice(2, 3));
		expect(p2.nextCursor).toBeNull();
		expect([...p1.items, ...p2.items].map((i) => i.id)).not.toContain(
			wrongCategory,
		);
	});
});

describe("conversations.getById — counterparty + labelable (FR-025)", () => {
	test("pre-FR-025 row ⇒ counterparty null (and no raw column leaks onto the wire)", async () => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
		});
		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.counterparty).toBeNull();
		// The five raw columns are lifted into `counterparty`; none may survive
		// the spread as a top-level field.
		for (const key of [
			"counterpartyState",
			"counterpartyE164",
			"counterpartyNameHint",
			"contactId",
			"contactName",
		]) {
			expect(res, key).not.toHaveProperty(key);
		}
	});

	test.each([
		{
			name: "known Polish number, no contact ⇒ labelable",
			seed: {
				counterpartyState: "known" as const,
				counterpartyE164: CP_NUMBER,
			},
			contact: false,
			labelable: true,
		},
		{
			name: "known Polish number already labeled ⇒ not labelable",
			seed: {
				counterpartyState: "known" as const,
				counterpartyE164: CP_NUMBER,
			},
			contact: true,
			labelable: false,
		},
		{
			name: "known foreign number ⇒ visible, not labelable (decision #3)",
			seed: {
				counterpartyState: "known" as const,
				counterpartyE164: CP_FOREIGN,
			},
			contact: false,
			labelable: false,
		},
		{
			name: "withheld ⇒ not labelable",
			seed: { counterpartyState: "withheld" as const },
			contact: false,
			labelable: false,
		},
		{
			name: "pending ⇒ not labelable",
			seed: { counterpartyState: "pending" as const },
			contact: false,
			labelable: false,
		},
	])("$name", async ({ seed, contact, labelable }) => {
		if (contact) {
			await seedContact({ userId: "me", name: "Zenobia", e164: CP_NUMBER });
		}
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyNameHint: CP_HINT,
			...seed,
		});
		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.counterparty?.state).toBe(seed.counterpartyState);
		expect(res.counterparty?.e164).toBe(seed.counterpartyE164 ?? null);
		expect(res.counterparty?.nameHint).toBe(CP_HINT);
		expect(res.counterparty?.contactName).toBe(contact ? "Zenobia" : null);
		expect(res.counterparty?.labelable).toBe(labelable);
	});

	test("does NOT leak another user's contact through the join", async () => {
		await seedContact({ userId: "other", name: "Obcy", e164: CP_NUMBER });
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		const res = await caller(makeCtx(true)).getById({ id });
		expect(res.counterparty?.contactName).toBeNull();
		expect(res.counterparty?.labelable).toBe(true);
	});
});

describe("conversations.labelCounterparty (FR-025)", () => {
	async function knownConversation(e164 = CP_NUMBER): Promise<string> {
		return seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: e164,
			counterpartyNameHint: CP_HINT,
		});
	}

	async function contactRows() {
		return db
			.select({ id: contacts.id, name: contacts.name, e164: contacts.e164 })
			.from(contacts)
			.where(eq(contacts.userId, "me"));
	}

	test("new: creates a contact carrying the conversation's number; the list row now shows the name", async () => {
		const id = await knownConversation();
		const res = await caller(makeCtx(true)).labelCounterparty({
			conversationId: id,
			target: { kind: "new", name: "  Zenobia (księgowa)  " },
		});
		expect(res.ok).toBe(true);

		// Written to `contacts` ONLY — trimmed name, the conversation's number.
		expect(await contactRows()).toEqual([
			{ id: res.contactId, name: "Zenobia (księgowa)", e164: CP_NUMBER },
		]);
		// Derived label, not stored: the join now finds it.
		const detail = await caller(makeCtx(true)).getById({ id });
		expect(detail.counterparty?.contactId).toBe(res.contactId);
		expect(detail.counterparty?.contactName).toBe("Zenobia (księgowa)");
		expect(detail.counterparty?.labelable).toBe(false);
		const list = await caller(makeCtx(true)).list({});
		expect(list.items[0]?.counterparty?.contactName).toBe("Zenobia (księgowa)");
		// The conversation row itself is untouched (no contact_id, number intact).
		expect(detail.counterparty?.e164).toBe(CP_NUMBER);
		expect(detail.counterparty?.nameHint).toBe(CP_HINT);
	});

	test("existing: writes the number onto a contact that has none", async () => {
		const id = await knownConversation();
		const contactId = await seedContact({ userId: "me", name: "Zenobia" });
		const res = await caller(makeCtx(true)).labelCounterparty({
			conversationId: id,
			target: { kind: "existing", contactId },
		});
		expect(res).toEqual({ ok: true, contactId });
		expect(await contactRows()).toEqual([
			{ id: contactId, name: "Zenobia", e164: CP_NUMBER },
		]);
		const detail = await caller(makeCtx(true)).getById({ id });
		expect(detail.counterparty?.contactName).toBe("Zenobia");
	});

	test("existing: a contact that already has a number ⇒ BAD_REQUEST, untouched", async () => {
		const id = await knownConversation();
		const contactId = await seedContact({
			userId: "me",
			name: "Marek",
			e164: "+48512345679",
		});
		await expect(
			caller(makeCtx(true)).labelCounterparty({
				conversationId: id,
				target: { kind: "existing", contactId },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(await contactRows()).toEqual([
			{ id: contactId, name: "Marek", e164: "+48512345679" },
		]);
	});

	test("existing: an unknown or foreign contact ⇒ NOT_FOUND", async () => {
		const id = await knownConversation();
		const foreign = await seedContact({ userId: "other", name: "Obcy" });
		for (const contactId of [foreign, "ct-does-not-exist"]) {
			await expect(
				caller(makeCtx(true)).labelCounterparty({
					conversationId: id,
					target: { kind: "existing", contactId },
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
		// The foreign contact was not written to.
		const [row] = await db
			.select({ e164: contacts.e164 })
			.from(contacts)
			.where(eq(contacts.id, foreign));
		expect(row?.e164).toBeNull();
	});

	test("existing: the target itself is judged before the holder ⇒ BAD_REQUEST / NOT_FOUND, never a CONFLICT naming it", async () => {
		const id = await knownConversation();
		// The picked contact already holds THIS number: the truer answer is
		// "that contact already has a number", not "the number belongs to <it>".
		const self = await seedContact({
			userId: "me",
			name: "Ja",
			e164: CP_NUMBER,
		});
		await expect(
			caller(makeCtx(true)).labelCounterparty({
				conversationId: id,
				target: { kind: "existing", contactId: self },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// The number is held, but the picked contact does not exist.
		await expect(
			caller(makeCtx(true)).labelCounterparty({
				conversationId: id,
				target: { kind: "existing", contactId: "ct-does-not-exist" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("a contact already holding the number ⇒ CONFLICT naming it, nothing written", async () => {
		const id = await knownConversation();
		const holder = await seedContact({
			userId: "me",
			name: "Zenobia",
			e164: CP_NUMBER,
		});
		const spare = await seedContact({ userId: "me", name: "Zapasowy" });
		for (const target of [
			{ kind: "new" as const, name: "Druga Zenobia" },
			{ kind: "existing" as const, contactId: spare },
		]) {
			await expect(
				caller(makeCtx(true)).labelCounterparty({ conversationId: id, target }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining("Zenobia"),
			});
		}
		expect(
			(await contactRows()).sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual(
			[
				{ id: holder, name: "Zenobia", e164: CP_NUMBER },
				{ id: spare, name: "Zapasowy", e164: null },
			].sort((a, b) => a.id.localeCompare(b.id)),
		);
	});

	test.each([
		{ name: "withheld", seed: { counterpartyState: "withheld" as const } },
		{ name: "pending", seed: { counterpartyState: "pending" as const } },
		{
			name: "unavailable",
			seed: { counterpartyState: "unavailable" as const },
		},
		{ name: "pre-FR-025 (NULL)", seed: {} },
		{
			name: "known but foreign number (decision #3)",
			seed: {
				counterpartyState: "known" as const,
				counterpartyE164: CP_FOREIGN,
			},
		},
	])("$name ⇒ BAD_REQUEST, no contact created", async ({ seed }) => {
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			...seed,
		});
		await expect(
			caller(makeCtx(true)).labelCounterparty({
				conversationId: id,
				target: { kind: "new", name: "Ktoś" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(await contactRows()).toEqual([]);
	});

	test("an empty / over-long name is rejected at the input boundary (shared contact schema)", async () => {
		const id = await knownConversation();
		for (const name of ["", "   ", "x".repeat(61)]) {
			await expect(
				caller(makeCtx(true)).labelCounterparty({
					conversationId: id,
					target: { kind: "new", name },
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(await contactRows()).toEqual([]);
	});

	test("a foreign/unknown conversation ⇒ NOT_FOUND", async () => {
		const otherId = await seedConversation({
			userId: "other",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
		});
		for (const conversationId of [otherId, "c-does-not-exist"]) {
			await expect(
				caller(makeCtx(true)).labelCounterparty({
					conversationId,
					target: { kind: "new", name: "Ktoś" },
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
	});

	test("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
		await expect(
			caller(makeCtx(false)).labelCounterparty({
				conversationId: "whatever",
				target: { kind: "new", name: "Ktoś" },
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("audit: exactly {contactId, conversationId, event, ts, userId} — neither the name nor the number", async () => {
		// POSITIVE and EXHAUSTIVE (the exact key set), as in `contacts.test.ts`:
		// "does not contain `name`" is also true of a misspelled field and of an
		// audit that was never written.
		const EXPECTED_KEYS = [
			"contactId",
			"conversationId",
			"event",
			"ts",
			"userId",
		];
		const id = await knownConversation();
		const spare = await seedContact({ userId: "me", name: "Zapasowa" });
		const second = await knownConversation("+48512345679");

		for (const [label, run] of [
			[
				"new",
				() =>
					caller(makeCtx(true)).labelCounterparty({
						conversationId: id,
						target: { kind: "new", name: "Zenobia Nowa" },
					}),
			],
			[
				"existing",
				() =>
					caller(makeCtx(true)).labelCounterparty({
						conversationId: second,
						target: { kind: "existing", contactId: spare },
					}),
			],
		] as const) {
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
			expect(captured, label).toHaveLength(1);
			const line = JSON.parse(captured[0] as string) as Record<string, unknown>;
			expect(Object.keys(line).sort(), label).toEqual(EXPECTED_KEYS);
			expect(line.event).toBe("conversation.counterparty_labeled");
			const raw = captured[0] as string;
			expect(raw).not.toContain("Zenobia");
			expect(raw).not.toContain("Zapasowa");
			expect(raw.replace(/\D/g, "")).not.toContain("512345678");
			expect(raw.replace(/\D/g, "")).not.toContain("512345679");
		}
	});
});

// The pre-write SELECTs in `labelCounterparty` are a courtesy; what actually
// keeps a contact's number from being overwritten (or duplicated) is the write
// itself — `isNull(contacts.e164)` in the UPDATE's WHERE and the
// `isUniqueViolation` catches. Those only run when the SELECTs LOSE a race, so
// these tests force one: the ctx db is wrapped so that a competing write lands
// in the one window that matters — after every check, right before the write
// executes. `Promise.all` cannot stage this: libsql serialises one connection,
// so the first mutation finishes before the second starts.
describe("conversations.labelCounterparty — the write is the guarantee (FR-025)", () => {
	/**
	 * Wrap `db` so the first awaited `update(...)`/`insert(...)` chain runs
	 * `race` before it executes. A drizzle builder is a thenable that executes
	 * in `then`, so deferring `then` is exactly "after the checks, before the
	 * write" without knowing how many SELECTs precede it.
	 */
	function racingDb(race: () => Promise<unknown>): typeof db {
		let fired = false;
		const wrapChain = (builder: object): object =>
			new Proxy(builder, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					if (prop === "then") {
						return (
							onFulfilled?: (v: unknown) => unknown,
							onRejected?: (e: unknown) => unknown,
						) => {
							const before = fired ? Promise.resolve() : race();
							fired = true;
							return before.then(() =>
								(target as PromiseLike<unknown>).then(onFulfilled, onRejected),
							);
						};
					}
					return (...args: unknown[]) => {
						const out = value.apply(target, args);
						return out !== null && typeof out === "object"
							? wrapChain(out)
							: out;
					};
				},
			});
		return new Proxy(db, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (prop === "update" || prop === "insert") {
					return (table: unknown) =>
						wrapChain((value as (t: unknown) => object).call(target, table));
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	function racingCtx(race: () => Promise<unknown>): Ctx {
		return { ...makeCtx(true), db: racingDb(race) } as Ctx;
	}

	async function knownConversation(): Promise<string> {
		return seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
			counterpartyNameHint: CP_HINT,
		});
	}

	async function numbersByContact(): Promise<Record<string, string | null>> {
		const rows = await db
			.select({ id: contacts.id, e164: contacts.e164 })
			.from(contacts)
			.where(eq(contacts.userId, "me"));
		return Object.fromEntries(rows.map((r) => [r.id, r.e164]));
	}

	test("existing: a competitor takes the number after the checks ⇒ CONFLICT from the unique index, target untouched", async () => {
		const id = await knownConversation();
		const target = await seedContact({ userId: "me", name: "Zenobia" });
		await expect(
			caller(
				racingCtx(() =>
					seedContact({
						userId: "me",
						id: "ct-racer",
						name: "Wyprzedził",
						e164: CP_NUMBER,
					}),
				),
			).labelCounterparty({
				conversationId: id,
				target: { kind: "existing", contactId: target },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await numbersByContact()).toEqual({
			[target]: null,
			"ct-racer": CP_NUMBER,
		});
	});

	test("existing: the target gains a number after the checks ⇒ BAD_REQUEST, that number is NOT overwritten", async () => {
		const id = await knownConversation();
		const target = await seedContact({ userId: "me", name: "Zenobia" });
		await expect(
			caller(
				racingCtx(() =>
					db
						.update(contacts)
						.set({ e164: "+48512345679" })
						.where(eq(contacts.id, target)),
				),
			).labelCounterparty({
				conversationId: id,
				target: { kind: "existing", contactId: target },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(await numbersByContact()).toEqual({ [target]: "+48512345679" });
	});

	test("new: a competitor takes the number after the checks ⇒ CONFLICT from the unique index, no second holder", async () => {
		const id = await knownConversation();
		await expect(
			caller(
				racingCtx(() =>
					seedContact({
						userId: "me",
						id: "ct-racer",
						name: "Wyprzedził",
						e164: CP_NUMBER,
					}),
				),
			).labelCounterparty({
				conversationId: id,
				target: { kind: "new", name: "Zenobia" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await numbersByContact()).toEqual({ "ct-racer": CP_NUMBER });
	});
});

describe("conversations.delete — the number goes with the row (FR-025)", () => {
	test("deleting a known conversation leaves no row holding its number; the contact is untouched", async () => {
		// Decision #2: the number dies only with the conversation — and it DOES
		// die with it. Regression assertion: a future move of the number into a
		// side table with no cascade would fail here.
		const contactId = await seedContact({
			userId: "me",
			name: "Zenobia",
			e164: CP_NUMBER,
		});
		const id = await seedConversation({
			userId: "me",
			createdAt: at("2026-10-19T10:00:00.000Z"),
			counterpartyState: "known",
			counterpartyE164: CP_NUMBER,
			counterpartyNameHint: CP_HINT,
		});
		await caller(makeCtx(true)).delete({ id });
		const left = await client.execute({
			sql: `SELECT count(*) AS n FROM "memo-call_conversations" WHERE counterparty_e164 = ? OR counterparty_name_hint = ?`,
			args: [CP_NUMBER, CP_HINT],
		});
		expect(Number(left.rows[0]?.n)).toBe(0);
		// By-value join, no FK: the contact survives its conversation.
		const [contact] = await db
			.select({ e164: contacts.e164 })
			.from(contacts)
			.where(eq(contacts.id, contactId));
		expect(contact?.e164).toBe(CP_NUMBER);
	});
});
