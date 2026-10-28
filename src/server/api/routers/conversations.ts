import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { safeErrorMessage } from "~/server/_lib/redact";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { createContactInput } from "~/server/contacts/schema";
import { isUniqueViolation } from "~/server/contacts/unique-violation";
import {
	SEARCH_MAX_CHARS,
	SEARCH_MIN_CHARS,
	UNASSIGNED_PROJECT,
} from "~/server/conversations/filter";
import { buildFtsMatchQuery } from "~/server/conversations/search";
import {
	type CounterpartyState,
	contacts,
	conversations,
	processingJobs,
	projects,
	tags,
	transcriptEdits,
} from "~/server/db/schema";
import { tombstoneCallSids } from "~/server/jobs/backfill";
import { JOB_HANDLERS } from "~/server/jobs/registry";
import { defaultWorkerDeps, type WorkerDeps } from "~/server/jobs/worker";
import { categorySchema } from "~/server/llm/schemas";
import type { TranscriptSegment } from "~/server/stt/types";
import { normalizeTags } from "~/server/tags/normalize";
import { telephony } from "~/server/telephony";
import { normalizePolishE164 } from "~/server/telephony/phone";

/**
 * Side-effect seam for the `reanalyze` mutation — injected so the router test can
 * isolate the durable-job kickoff (a spy), exactly mirroring `jobs.ts` `onReplay`.
 * The production default funnels through the re-analyze worker's atomic claim,
 * resolved from the job-kind registry (so this router names no worker module),
 * built against the request-scoped `ctx.db`.
 *
 * The kind is a literal here — unlike `jobs.replay`, which routes a job it did
 * not create, this mutation is *creating* a re-analyze job, so the kind is an
 * input to dispatch, not a lookup.
 */
export type ConversationsRouterDeps = {
	onReanalyze: (jobId: string, db: WorkerDeps["db"]) => void;
};

const DEFAULT_DEPS: ConversationsRouterDeps = {
	onReanalyze: (jobId, db) =>
		JOB_HANDLERS.reanalyze.kickoff(jobId, defaultWorkerDeps(db)),
};

/** zod schema for one editable transcript turn (mirrors `TranscriptSegment`). */
const transcriptSegmentSchema = z.object({
	speaker: z.string().min(1),
	text: z.string(),
	startMs: z.number().optional(),
	endMs: z.number().optional(),
}) satisfies z.ZodType<TranscriptSegment>;

/**
 * First real panel surface (PRD FR-010/FR-011): the chronological conversation
 * list + category filter. A single `list` query, `protectedProcedure`, scoped on
 * the constant `ctx.userId` even though it is `'me'` — every call site stays
 * multi-user-shaped from line one (mirrors `jobs.ts`).
 *
 * Per-row pipeline status is derived in TWO queries, not a `leftJoin
 * processing_jobs`. The conversation⟷job relation is de-facto 1:1 (one job insert
 * at webhook ingress, `jobs.replay` mutates in place — no scheduler insert), but
 * the join side is 1:N at the schema level (`job_user_conv_idx` is NON-unique), so
 * a blind `leftJoin` could fan out one display row into N and corrupt the
 * `limit + 1` keyset page count. Query 1 fetches the conversation page (joining
 * only the 1:1 `projects` label). Query 2 is a bounded `inArray(conversationId,
 * pageIds)` status lookup, reduced to the latest job per conversation in plain TS.
 * This keeps the whole thing pure Drizzle-builder (correctly quotes the
 * `memo-call_` prefix + the mixed camelCase/snake_case columns — see CLAUDE.md "Lessons")
 * and makes the "one row per conversation" invariant a testable JS reduction
 * rather than a fight with SQL fan-out semantics.
 */

const PER_ROW_STATUS = ["in_progress", "failed", "done"] as const;
type PerRowStatus = (typeof PER_ROW_STATUS)[number];

/**
 * Single source of truth for the per-conversation pipeline status, shared by
 * `list` and `getById`. analysis present ⇒ done (the worker writes it only in the
 * done-txn); else a failed job ⇒ failed; else (pending/transcribing/analyzing or
 * no job yet) ⇒ in_progress. Never gated — NULL-analysis rows still surface
 * (voicemail_processed_not_gated).
 */
function deriveStatus(
	hasAnalysis: boolean,
	latestJobStatus: string | undefined,
): PerRowStatus {
	return hasAnalysis
		? "done"
		: latestJobStatus === "failed"
			? "failed"
			: "in_progress";
}

/**
 * Opaque keyset cursor over `(createdAt, id)`. `createdAt` is second-resolution
 * (`schema.ts` `unixepoch()`), so the `id` tie-break is REQUIRED — two same-second
 * rows would otherwise be skipped or duplicated across a page boundary. Encoded as
 * base64url JSON so the wire shape is opaque; decode is fail-loud (`BAD_REQUEST`)
 * on any malformed input.
 */
type Cursor = { createdAt: Date; id: string };

function encodeCursor(row: Cursor): string {
	const payload = { t: Math.floor(row.createdAt.getTime() / 1000), id: row.id };
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, "base64url").toString("utf8"),
		) as { t?: unknown; id?: unknown } | null;
		if (
			!parsed ||
			typeof parsed.t !== "number" ||
			!Number.isFinite(parsed.t) ||
			typeof parsed.id !== "string" ||
			parsed.id.length === 0
		) {
			throw new Error("malformed cursor payload");
		}
		return { createdAt: new Date(parsed.t * 1000), id: parsed.id };
	} catch {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
	}
}

/**
 * The other party of a conversation, as `list` and `getById` return it
 * (FR-025, `caller-identity-in-archive` phase 4). The server picks NOTHING: it
 * hands every field over and the panel applies the precedence (contact name →
 * operator hint → number → state). `null` means the row predates FR-025
 * (`counterparty_state IS NULL`) and the panel shows no line at all — such a
 * row never receives a number (owner decision #4, no backfill).
 *
 * `contactId`/`contactName` come from a `LEFT JOIN contacts ON e164` — matched
 * BY VALUE, deliberately without a `contact_id` FK on the conversation, so
 * deleting a contact returns its conversations to "number only" with no
 * cascade and nothing dangling. The join is 1:1 because `contact_user_e164_uq`
 * allows at most one contact per (user, number), so it can never fan a page row
 * out and corrupt the `limit + 1` keyset (the router test pages two
 * same-number conversations through one contact to prove it).
 *
 * ⚠️ The user predicate on the join belongs in the `ON`, never in the `WHERE`:
 * a conversation with no contact joins to an all-NULL right side, and
 * `NULL = 'me'` in a `WHERE` would turn the LEFT JOIN inner and drop every
 * unlabeled conversation from the list (`calls.ts` `history`, `projects.ts`).
 */
type CounterpartyRow = {
	counterpartyState: CounterpartyState | null;
	counterpartyE164: string | null;
	counterpartyNameHint: string | null;
	contactId: string | null;
	contactName: string | null;
};

export type Counterparty = {
	state: CounterpartyState;
	e164: string | null;
	nameHint: string | null;
	contactId: string | null;
	contactName: string | null;
};

function shapeCounterparty(row: CounterpartyRow): Counterparty | null {
	if (row.counterpartyState === null) return null;
	return {
		state: row.counterpartyState,
		e164: row.counterpartyE164,
		nameHint: row.counterpartyNameHint,
		contactId: row.contactId,
		contactName: row.contactName,
	};
}

/**
 * Whether the detail view may offer the "label this number" control: the
 * number is known, it is one the contact book can hold (`normalizePolishE164`
 * is the book's single validation boundary — a foreign number is shown but not
 * labelable, decision #3), and no contact holds it yet. The mutation below
 * re-derives the same three conditions server-side; this flag only spares the
 * panel a round-trip that would end in `BAD_REQUEST`.
 */
function isLabelable(c: Counterparty | null): boolean {
	return (
		c !== null &&
		c.state === "known" &&
		c.e164 !== null &&
		normalizePolishE164(c.e164) === c.e164 &&
		c.contactId === null
	);
}

export function createConversationsRouter(
	deps: ConversationsRouterDeps = DEFAULT_DEPS,
) {
	return createTRPCRouter({
		// All conversations for this user, newest-first, keyset-paginated, optionally
		// filtered by category AND/OR a set of tags AND/OR a project. The filter is an
		// OBJECT so S-05 (FR-019) added `tags?: string[]` (AND-combined) with zero
		// restructuring; `projectId` is the third use of that same door.
		list: protectedProcedure
			.input(
				z.object({
					filter: z
						.object({
							category: categorySchema.optional(),
							// FR-019: AND-combined tag filter. Names are canonicalized
							// server-side (defense-in-depth — the client sends canonical
							// names from `tags.listWithCounts`, but a stale/raw value still
							// narrows correctly instead of silently matching nothing).
							tags: z.array(z.string()).optional(),
							// The primary axis. `UNASSIGNED_PROJECT` ("__none__") is a
							// SENTINEL, not an id: it selects conversations with no project.
							// Deliberately not modelled as `projectId: string | null`, because
							// react-query hashes the whole input into the cache key — a `null`
							// would be a DIFFERENT key from an omitted field, so "no project
							// filter" and "conversations without a project" could no longer
							// share the "omit the filter object entirely" rule that keeps the
							// default query key byte-identical to the SSR prefetch's
							// (see `_lib/list-config.ts`). Keeping the whole variant inside
							// `string` means the client has ONE rule: add the key only when a
							// filter is active. An id that does not exist yields an empty page,
							// never an error — same as an unknown tag name.
							projectId: z.string().min(1).optional(),
							// Full-text phrase over transcript + summary (the FTS5 index in
							// `drizzle/0005_conversations_fts.sql`). Raw user text — the
							// folding/quoting that makes it safe for `MATCH` happens in
							// `~/server/conversations/search`, never here.
							q: z
								.string()
								.trim()
								.min(SEARCH_MIN_CHARS)
								.max(SEARCH_MAX_CHARS)
								.optional(),
							// FR-025: "what did we settle with X" — conversations whose
							// counterparty number is the one this contact holds. An id (the
							// contact's), never a number: a raw number would otherwise travel
							// through react-query keys and the URL. An unknown contact, a
							// foreign one, or one with no number yields an empty page, not an
							// error — same contract as an unknown project id.
							contactId: z.string().min(1).optional(),
						})
						.optional(),
					cursor: z.string().optional(),
					limit: z.number().int().min(1).max(100).default(20),
				}),
			)
			.query(async ({ ctx, input }) => {
				const { filter, cursor, limit } = input;
				const keyset = cursor ? decodeCursor(cursor) : null;

				// FR-019 AND tag-filter, evaluated IN SQL inside the keyset WHERE (before
				// `.limit()`) — filtering the page array post-fetch would corrupt the
				// keyset cursor (computed from the returned rows). A conversation survives
				// only if it carries ALL of the selected tags: the correlated subquery
				// selects conversation_ids whose distinct-name count over the selected set
				// equals the selected count (`GROUP BY … HAVING COUNT(DISTINCT name) = N`).
				// Empty/absent tags ⇒ no predicate (`undefined`), so the default query key
				// is byte-identical to the pre-S-05 shape. `.having()` + subquery-in-
				// `inArray()` were unproven in this repo; both render + run correctly
				// (prototyped against a throwaway libsql DB per CLAUDE.md "Lessons" before landing).
				const normalizedTags = filter?.tags ? normalizeTags(filter.tags) : [];
				const tagPredicate =
					normalizedTags.length > 0
						? inArray(
								conversations.id,
								ctx.db
									.select({ id: tags.conversationId })
									.from(tags)
									.where(
										and(
											eq(tags.userId, ctx.userId),
											inArray(tags.name, normalizedTags),
										),
									)
									.groupBy(tags.conversationId)
									.having(
										sql`count(distinct ${tags.name}) = ${normalizedTags.length}`,
									),
							)
						: undefined;

				// Primary-axis narrowing. The sentinel branch is the reason this filter
				// exists at all in this shape: without it the whole class of UNASSIGNED
				// conversations is unreachable by any filter, and those are precisely the
				// ones that need attention. `isNull` on the column, NOT a comparison to a
				// literal — SQL `= NULL` is never true.
				const projectPredicate = filter?.projectId
					? filter.projectId === UNASSIGNED_PROJECT
						? isNull(conversations.projectId)
						: eq(conversations.projectId, filter.projectId)
					: undefined;

				// FR-025 contact narrowing: `counterparty_e164 = (SELECT e164 FROM
				// contacts WHERE id = ? AND user_id = ?)`. A scalar subquery, evaluated
				// once, in the SAME WHERE as the keyset (post-fetch filtering would
				// corrupt the cursor — the rule every filter here follows). When the
				// contact is unknown, foreign, or has no number the subquery is NULL,
				// and `= NULL` is never true: an honest empty page. The subquery, not a
				// pre-resolved number from a prior SELECT, so the number never becomes
				// a JS value this handler holds for anything but the row shape.
				const contactPredicate = filter?.contactId
					? eq(
							conversations.counterpartyE164,
							ctx.db
								.select({ e164: contacts.e164 })
								.from(contacts)
								.where(
									and(
										eq(contacts.id, filter.contactId),
										eq(contacts.userId, ctx.userId),
									),
								),
						)
					: undefined;

				// Full-text narrowing, evaluated IN SQL inside the same WHERE as the
				// keyset (like the tag filter) so the cursor stays correct. A RAW `sql`
				// fragment rather than a builder subquery: the FTS5 table is a hand-
				// written virtual table with no `schema.ts` object to build from
				// (drizzle-kit cannot model it). The phrase is a BOUND PARAMETER —
				// `${}` in drizzle's `sql` template binds, never interpolates — and it
				// has already been reduced to quoted letter/digit tokens, so nothing the
				// user typed can reach the FTS5 query parser as syntax. A phrase with no
				// token at all (`"--"`) matches NOTHING rather than dropping the filter:
				// the user asked to narrow, and "everything" would be the wrong answer.
				//
				// `id IN (SELECT …)` (an uncorrelated LIST SUBQUERY, run once) rather
				// than the correlated `EXISTS (… AND f.conversation_id = id)` the plan
				// sketched: the latter re-runs the MATCH for every candidate row.
				// Measured in the phase-2 review on 5 000 rows × 60 words — hit 54 ms
				// → 3.9 ms, miss 26 ms → 0.3 ms — with identical semantics under the
				// keyset (tests 2.5–2.15 + the keyset-under-phrase test cover it).
				const matchQuery =
					filter?.q !== undefined ? buildFtsMatchQuery(filter.q) : undefined;
				const searchPredicate =
					matchQuery === undefined
						? undefined
						: matchQuery === null
							? sql`0`
							: sql`${conversations.id} in (
									select f.conversation_id from "memo-call_conversations_fts" f
									where f."memo-call_conversations_fts" match ${matchQuery})`;

				// --- Query 1: the conversation page (1:1 `projects` label join only). ---
				// Keyset predicate is decomposed because drizzle-orm 0.45.2's SQLite
				// builder has no tuple operator: `(createdAt, id) < (?, ?)` is written as
				// `createdAt < ? OR (createdAt = ? AND id < ?)`.
				const rows = await ctx.db
					.select({
						id: conversations.id,
						category: conversations.category,
						projectId: conversations.projectId,
						projectName: projects.name,
						categoryOverridden: conversations.categoryOverridden,
						projectOverridden: conversations.projectOverridden,
						analysis: conversations.analysis,
						createdAt: conversations.createdAt,
						counterpartyState: conversations.counterpartyState,
						counterpartyE164: conversations.counterpartyE164,
						counterpartyNameHint: conversations.counterpartyNameHint,
						contactId: contacts.id,
						contactName: contacts.name,
					})
					.from(conversations)
					// Scope the join target on userId too: `projects` is a user-owned table,
					// so the multi-user-ready invariant (CLAUDE.md: every user-owned-table
					// query filters eq(userId)) applies to the join, not just the FROM. Benign
					// under single-user, but this router is the template S-02/S-03/S-05 clone.
					.leftJoin(
						projects,
						and(
							eq(conversations.projectId, projects.id),
							eq(projects.userId, ctx.userId),
						),
					)
					// FR-025: the contact label, BY VALUE and 1:1 — see `shapeCounterparty`.
					// User predicate in the ON (a `WHERE` would drop unlabeled rows).
					.leftJoin(
						contacts,
						and(
							eq(contacts.e164, conversations.counterpartyE164),
							eq(contacts.userId, ctx.userId),
						),
					)
					.where(
						and(
							eq(conversations.userId, ctx.userId),
							filter?.category
								? eq(conversations.category, filter.category)
								: undefined,
							tagPredicate,
							projectPredicate,
							contactPredicate,
							searchPredicate,
							keyset
								? or(
										lt(conversations.createdAt, keyset.createdAt),
										and(
											eq(conversations.createdAt, keyset.createdAt),
											lt(conversations.id, keyset.id),
										),
									)
								: undefined,
						),
					)
					.orderBy(desc(conversations.createdAt), desc(conversations.id))
					.limit(limit + 1);

				const hasMore = rows.length > limit;
				const pageRows = hasMore ? rows.slice(0, limit) : rows;
				const nextCursor = hasMore
					? encodeCursor(pageRows[pageRows.length - 1] as Cursor)
					: null;

				// --- Query 2: bounded latest-job-status lookup for the page. ---
				const pageIds = pageRows.map((r) => r.id);
				const latestStatusByConv = new Map<
					string,
					{ status: string; at: Date }
				>();
				if (pageIds.length > 0) {
					const jobRows = await ctx.db
						.select({
							conversationId: processingJobs.conversationId,
							status: processingJobs.status,
							updatedAt: processingJobs.updatedAt,
						})
						.from(processingJobs)
						.where(
							and(
								eq(processingJobs.userId, ctx.userId),
								inArray(processingJobs.conversationId, pageIds),
							),
						);
					for (const job of jobRows) {
						const prev = latestStatusByConv.get(job.conversationId);
						// De-facto 1:1, but pick the latest deterministically so a (replay-
						// produced) multi-job conversation still resolves to ONE status.
						if (!prev || job.updatedAt.getTime() > prev.at.getTime()) {
							latestStatusByConv.set(job.conversationId, {
								status: job.status,
								at: job.updatedAt,
							});
						}
					}
				}

				const items = pageRows.map((row) => {
					const jobStatus = latestStatusByConv.get(row.id)?.status;
					return {
						id: row.id,
						category: row.category,
						projectId: row.projectId,
						projectName: row.projectName,
						// FR-016 auto/override indicator: either flag ⇒ user-owned ("ręcznie").
						categoryOverridden: row.categoryOverridden,
						projectOverridden: row.projectOverridden,
						summary: row.analysis?.summary ?? null,
						createdAt: row.createdAt,
						status: deriveStatus(row.analysis != null, jobStatus),
						// FR-025: who the conversation was with, in every row — the list
						// answers it without opening the conversation.
						counterparty: shapeCounterparty(row),
					};
				});

				return { items, nextCursor };
			}),

		// Full conversation payload for the detail page (FR-023 fetch-on-page-load).
		// Scoped to `ctx.userId` → NOT_FOUND for a foreign/unknown id (never a 500 or a
		// cross-user leak). Reuses `deriveStatus` so the detail badge and the list row
		// can never disagree about a conversation's pipeline state.
		getById: protectedProcedure
			.input(z.object({ id: z.string().min(1) }))
			.query(async ({ ctx, input }) => {
				const [row] = await ctx.db
					.select({
						id: conversations.id,
						category: conversations.category,
						projectId: conversations.projectId,
						projectName: projects.name,
						categoryOverridden: conversations.categoryOverridden,
						projectOverridden: conversations.projectOverridden,
						analysis: conversations.analysis,
						transcriptSegments: conversations.transcriptSegments,
						transcriptLanguage: conversations.transcriptLanguage,
						durationMs: conversations.durationMs,
						// S-06 indicators (FR-020/FR-021): rendered as "Edytowano <date>" /
						// "Przeanalizowano ponownie <date>" in the panel.
						transcriptEditedAt: conversations.transcriptEditedAt,
						reanalyzedAt: conversations.reanalyzedAt,
						createdAt: conversations.createdAt,
						counterpartyState: conversations.counterpartyState,
						counterpartyE164: conversations.counterpartyE164,
						counterpartyNameHint: conversations.counterpartyNameHint,
						contactId: contacts.id,
						contactName: contacts.name,
					})
					.from(conversations)
					// Same user-scoped project-label join as `list` (don't leak a foreign name).
					.leftJoin(
						projects,
						and(
							eq(conversations.projectId, projects.id),
							eq(projects.userId, ctx.userId),
						),
					)
					// Same by-value, user-scoped contact join as `list` (FR-025).
					.leftJoin(
						contacts,
						and(
							eq(contacts.e164, conversations.counterpartyE164),
							eq(contacts.userId, ctx.userId),
						),
					)
					.where(
						and(
							eq(conversations.id, input.id),
							eq(conversations.userId, ctx.userId),
						),
					);

				if (!row) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No conversation with that id",
					});
				}
				// Lift the five raw columns out of the spread below into ONE shaped
				// field, so the wire shape is `counterparty` (or null) and nothing else.
				const {
					counterpartyState,
					counterpartyE164,
					counterpartyNameHint,
					contactId,
					contactName,
					...detail
				} = row;
				const counterparty = shapeCounterparty({
					counterpartyState,
					counterpartyE164,
					counterpartyNameHint,
					contactId,
					contactName,
				});

				// Latest job status for this one conversation (mirrors the list's reduction —
				// the job side is 1:N at the schema level, so pick the latest deterministically).
				const jobRows = await ctx.db
					.select({
						status: processingJobs.status,
						kind: processingJobs.kind,
						updatedAt: processingJobs.updatedAt,
					})
					.from(processingJobs)
					.where(
						and(
							eq(processingJobs.userId, ctx.userId),
							eq(processingJobs.conversationId, input.id),
						),
					);
				let latest: { status: string; kind: string; at: Date } | undefined;
				for (const job of jobRows) {
					if (!latest || job.updatedAt.getTime() > latest.at.getTime()) {
						latest = { status: job.status, kind: job.kind, at: job.updatedAt };
					}
				}
				// S-06 in-progress / failed signals, derived from the LATEST job's
				// kind+status (additive to deriveStatus, which keys terminality on analysis
				// presence and so cannot express "re-analyzing" for an already-done conv).
				const reanalyzing =
					latest?.kind === "reanalyze" &&
					(latest.status === "pending" || latest.status === "analyzing");
				const lastReanalyzeFailed =
					latest?.kind === "reanalyze" && latest.status === "failed";

				// S-05: the editable tag rows (the detail view reads THESE, not the
				// immutable `analysis.candidateTags` JSON). Ordered (createdAt, name) for a
				// stable render. The conversation-level "user-edited tags" indicator
				// (FR-018) is DERIVED client-side as `tags.some(t => t.isUserEdited)` — no
				// extra column. Scoped on userId like every other user-owned-table query.
				const tagRows = await ctx.db
					.select({
						id: tags.id,
						name: tags.name,
						isUserEdited: tags.isUserEdited,
					})
					.from(tags)
					.where(
						and(eq(tags.userId, ctx.userId), eq(tags.conversationId, input.id)),
					)
					.orderBy(asc(tags.createdAt), asc(tags.name));

				return {
					...detail,
					status: deriveStatus(detail.analysis != null, latest?.status),
					tags: tagRows,
					reanalyzing,
					lastReanalyzeFailed,
					counterparty: counterparty
						? { ...counterparty, labelable: isLabelable(counterparty) }
						: null,
				};
			}),

		// FR-025: give the counterparty number a name from the contact book —
		// either write it onto an existing contact that has NO number yet, or
		// create a new contact carrying it. The label itself is never stored on
		// the conversation: `list`/`getById` derive it by joining on the number,
		// so this mutation writes ONLY to `contacts`.
		//
		// ⚠️ THE NUMBER NEVER COMES FROM THE CLIENT. It is read from the
		// conversation row (user-scoped) — a client-supplied number would turn
		// this into a general "attach any number to any contact" endpoint and let
		// a stale or forged payload label the wrong person. Which also means this
		// router still never WRITES `counterparty_e164`: it reads it and hands it
		// to `contacts.e164` (`counterparty-write-path.test.ts`, guard #5).
		//
		// Refusals, in order: unknown/foreign conversation → NOT_FOUND; state ≠
		// `known` or a number the contact book cannot hold (foreign; decision #3)
		// → BAD_REQUEST; `existing` with an unknown/foreign contact → NOT_FOUND,
		// with one that has a number → BAD_REQUEST (overwriting a contact's
		// number from the conversation view is out of scope — `contacts.update`
		// is the one place for that); a contact already holding the number →
		// CONFLICT naming it (the `contacts.create` courtesy — safe for the
		// reason documented there: a TRPCError message reaches the owner's
		// screen, never the log).
		//
		// ⚠️ NO `onConflict*`: `contact_user_e164_uq` is PARTIAL and drizzle
		// mis-positions the predicate (CLAUDE.md "Lessons"). The SELECT is the courtesy;
		// `isUniqueViolation` on the write is the guarantee when the SELECT loses
		// a race. The `existing` UPDATE additionally carries `e164 IS NULL` in
		// its WHERE, so a contact that gained a number between the check and the
		// write is left alone (zero rows → BAD_REQUEST), never overwritten.
		labelCounterparty: protectedProcedure
			.input(
				z.object({
					conversationId: z.string().min(1),
					target: z.discriminatedUnion("kind", [
						z.object({
							kind: z.literal("existing"),
							contactId: z.string().min(1),
						}),
						// Same name rule as `contacts.create` (trim, 1–60) — one schema,
						// so the two ways of naming a contact cannot drift apart.
						z.object({
							kind: z.literal("new"),
							name: createContactInput.shape.name,
						}),
					]),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const [conv] = await ctx.db
					.select({
						state: conversations.counterpartyState,
						e164: conversations.counterpartyE164,
					})
					.from(conversations)
					.where(
						and(
							eq(conversations.id, input.conversationId),
							eq(conversations.userId, ctx.userId),
						),
					);
				if (!conv) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Nie ma takiej rozmowy",
					});
				}
				if (
					conv.state !== "known" ||
					conv.e164 === null ||
					normalizePolishE164(conv.e164) !== conv.e164
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Tej rozmowy nie da się podpiąć pod kontakt — numer jest nieznany albo niepolski",
					});
				}
				const e164 = conv.e164;

				// The target is judged BEFORE the holder: "this contact is unknown" or
				// "this contact already has a number" is the truer answer than a
				// CONFLICT that may name the very contact the user picked.
				const target = input.target;
				if (target.kind === "existing") {
					const [contact] = await ctx.db
						.select({ e164: contacts.e164 })
						.from(contacts)
						.where(
							and(
								eq(contacts.id, target.contactId),
								eq(contacts.userId, ctx.userId),
							),
						);
					if (!contact) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Nie ma takiego kontaktu",
						});
					}
					if (contact.e164 !== null) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Ten kontakt ma już numer",
						});
					}
				}

				const [holder] = await ctx.db
					.select({ name: contacts.name })
					.from(contacts)
					.where(and(eq(contacts.userId, ctx.userId), eq(contacts.e164, e164)))
					.limit(1);
				if (holder) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `Ten numer należy już do kontaktu „${holder.name}”`,
					});
				}

				let contactId: string;
				if (target.kind === "existing") {
					let changed: { id: string }[];
					try {
						changed = await ctx.db
							.update(contacts)
							.set({ e164 })
							.where(
								and(
									eq(contacts.id, target.contactId),
									eq(contacts.userId, ctx.userId),
									isNull(contacts.e164),
								),
							)
							.returning({ id: contacts.id });
					} catch (err) {
						if (!isUniqueViolation(err)) throw err;
						throw new TRPCError({
							code: "CONFLICT",
							message: "Ten numer należy już do innego kontaktu",
						});
					}
					// Zero rows: the contact gained a number or was deleted after the
					// check above — either way it is no longer what the user picked.
					if (changed.length === 0) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message:
								"Kontakt zmienił się w międzyczasie — odśwież stronę i spróbuj ponownie",
						});
					}
					contactId = target.contactId;
				} else {
					contactId = crypto.randomUUID();
					try {
						await ctx.db.insert(contacts).values({
							id: contactId,
							userId: ctx.userId,
							name: target.name,
							e164,
						});
					} catch (err) {
						if (!isUniqueViolation(err)) throw err;
						throw new TRPCError({
							code: "CONFLICT",
							message: "Ten numer należy już do innego kontaktu",
						});
					}
				}

				// Audit (parity with `contacts.ts`): the EXACT key set is asserted by
				// the router test. Ids only, NEVER the name or the number: the line
				// does link a conversation to a contact BY ID (`conversationId` +
				// `contactId`, like every `contact.*` line), which is harmless in Fly's
				// ~7-day log window — readable text such as "this recording was with
				// <name>" is what must not sit there. Do not "enrich" it with a name.
				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "conversation.counterparty_labeled",
						userId: ctx.userId,
						conversationId: input.conversationId,
						contactId,
					}),
				);
				return { ok: true as const, contactId };
			}),

		// FR-016: user override of the auto-classification. Enforces the category∈project
		// rule server-side (the LLM-side rule from classify(), re-asserted at the write
		// boundary) and marks the WHOLE pair user-owned so the worker's override guard
		// skips re-classification on a future re-analyze (S-06). Mirrors the
		// `jobs.replay` / `projects.delete` ownership-guard pattern.
		overrideClassification: protectedProcedure
			.input(
				z.object({
					conversationId: z.string().min(1),
					category: categorySchema,
					projectId: z.string().min(1).nullable(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				// Non-atomic by design (no wrapping txn): the existence check, the project
				// check, and the UPDATE are separate statements. The TOCTOU window (e.g. a
				// concurrent projects.delete between the category check and the UPDATE) is
				// consciously accepted under the strict-single-user page-load model — and
				// the project FK is ON DELETE SET NULL, so the end state stays consistent
				// regardless. Same accepted tradeoff as projects.create's uniqueness check.
				// The conversation must exist and belong to the user.
				const [conv] = await ctx.db
					.select({ id: conversations.id })
					.from(conversations)
					.where(
						and(
							eq(conversations.id, input.conversationId),
							eq(conversations.userId, ctx.userId),
						),
					);
				if (!conv) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No conversation with that id",
					});
				}

				// A chosen project must exist, be user-owned, AND match the chosen category.
				// A foreign/unknown id is NOT_FOUND; a real-but-wrong-category id is
				// BAD_REQUEST (the category∈project constraint). `projectId: null` clears it.
				if (input.projectId !== null) {
					const [project] = await ctx.db
						.select({ category: projects.category })
						.from(projects)
						.where(
							and(
								eq(projects.id, input.projectId),
								eq(projects.userId, ctx.userId),
							),
						);
					if (!project) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "No project with that id",
						});
					}
					if (project.category !== input.category) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Project does not belong to the chosen category",
						});
					}
				}

				await ctx.db
					.update(conversations)
					.set({
						category: input.category,
						projectId: input.projectId,
						categoryOverridden: true,
						projectOverridden: true,
					})
					.where(
						and(
							eq(conversations.id, input.conversationId),
							eq(conversations.userId, ctx.userId),
						),
					);

				// FR-016 audit: a user-driven classification override is an inspectable
				// state mutation (parity with jobs.replay's logJobEvent). Structured JSON on
				// stderr — same shape + channel as the job/auth audit modules, visible in
				// `fly logs`. One call site, so kept inline rather than a new audit module.
				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "conversation.classification_overridden",
						userId: ctx.userId,
						conversationId: input.conversationId,
						category: input.category,
						projectId: input.projectId,
					}),
				);
				return { ok: true as const };
			}),

		// Permanently delete one conversation. select-then-delete (NOT the
		// single-statement `delete().returning()` of `projects.delete`) because we need
		// `recordingSid`/`recordingDeletedAt` BEFORE the row is gone: the conversation
		// row is the only handle the FR-002 `runDeleteSweep` has to a still-resident
		// recording, so hard-deleting it would orphan the recording at the provider.
		// Existence is established by the select (length-0 → NOT_FOUND); the row delete
		// cascades to tags / transcript_edits / processing_jobs (PRAGMA foreign_keys=ON
		// per connection). Mirrors the `jobs.replay` / `projects.delete` ownership guard.
		delete: protectedProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				const [row] = await ctx.db
					.select({
						recordingSid: conversations.recordingSid,
						recordingDeletedAt: conversations.recordingDeletedAt,
					})
					.from(conversations)
					.where(
						and(
							eq(conversations.id, input.id),
							eq(conversations.userId, ctx.userId),
						),
					);
				if (!row) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No conversation with that id",
					});
				}

				// FR-002 best-effort cleanup: proactively delete a still-resident recording
				// at the provider before the row (its only handle) disappears. A failure is
				// logged, NOT fatal — unlike the sweep, there is no retry after the row is
				// gone, so this is the last chance. Mirrors the worker's post-done inline
				// delete (worker.ts) + the sweep's error-log shape (scheduler.ts).
				if (row.recordingSid && row.recordingDeletedAt == null) {
					try {
						await telephony.deleteRecording({ recordingSid: row.recordingSid });
					} catch (err) {
						console.error(
							JSON.stringify({
								ts: Date.now(),
								event: "conversation.delete_recording_failed",
								userId: ctx.userId,
								conversationId: input.id,
								error: safeErrorMessage(err),
							}),
						);
					}
				}

				// The delete and its TOMBSTONE are one transaction, and that atomicity
				// is the guarantee — not tidiness. Capture reconciliation detects a
				// lost note as "a recording still resident at the provider with no
				// `conversations` row", which is exactly what this mutation produces
				// whenever the best-effort provider delete above failed. A row deleted
				// without its tombstone is therefore resurrected by the next sweep
				// (≤5 min), re-sent to Deepgram + Bedrock, and — once that job succeeds
				// — kept for good, silently undoing the user's deletion. See
				// `reconcile_tombstones` in `schema.ts`.
				await ctx.db.transaction(async (tx) => {
					const deleted = await tx
						.delete(conversations)
						.where(
							and(
								eq(conversations.id, input.id),
								eq(conversations.userId, ctx.userId),
							),
						)
						.returning({ callSid: conversations.callSid });
					await tombstoneCallSids(tx, {
						userId: ctx.userId,
						callSids: deleted.map((r) => r.callSid),
					});
				});

				// Audit the irreversible destructive op (parity with the override audit):
				// structured JSON on stderr, visible in `fly logs`.
				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "conversation.deleted",
						userId: ctx.userId,
						conversationId: input.id,
					}),
				);
				return { ok: true as const };
			}),

		// FR-020: persist an edited per-turn transcript. Overwrites `transcriptSegments`
		// in place, stamps the O(1) `transcript_edited_at` indicator, and writes a
		// `transcript_edits` audit row (the dormant table this slot was designed for —
		// audit-only: it stores `edited_at`, NOT the edited content). Editing does NOT
		// auto-trigger re-analysis (Save and Re-analyze are separate actions). Mirrors the
		// `overrideClassification` select-then-write + audit pattern.
		updateTranscript: protectedProcedure
			.input(
				z.object({
					conversationId: z.string().min(1),
					segments: z.array(transcriptSegmentSchema).min(1),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const [conv] = await ctx.db
					.select({ id: conversations.id })
					.from(conversations)
					.where(
						and(
							eq(conversations.id, input.conversationId),
							eq(conversations.userId, ctx.userId),
						),
					);
				if (!conv) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No conversation with that id",
					});
				}

				const now = new Date();
				// Both writes are intentional: `transcript_edited_at` is the O(1) indicator
				// getById reads on every load (no MAX() subquery), while the `transcript_edits`
				// row is the append-only edit history. The column is derivable from
				// MAX(transcript_edits.edited_at) but kept denormalized for read cost.
				await ctx.db.transaction(async (tx) => {
					await tx
						.update(conversations)
						.set({
							transcriptSegments: input.segments,
							transcriptEditedAt: now,
						})
						.where(
							and(
								eq(conversations.id, input.conversationId),
								eq(conversations.userId, ctx.userId),
							),
						);
					await tx.insert(transcriptEdits).values({
						id: crypto.randomUUID(),
						userId: ctx.userId,
						conversationId: input.conversationId,
						editedAt: now,
					});
				});

				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "conversation.transcript_edited",
						userId: ctx.userId,
						conversationId: input.conversationId,
					}),
				);
				return { ok: true as const };
			}),

		// FR-021: enqueue + kick off a durable re-analyze job (kind='reanalyze'). Refuses
		// when there's nothing to analyze (empty transcript) or one is already in flight.
		// The job regenerates analysis content + (override-guarded) classification +
		// (per-tag-merged) tags off the request path — see `reanalyze.ts`. Mirrors
		// `jobs.replay`'s injected-side-effect (`onReanalyze`) DI pattern.
		reanalyze: protectedProcedure
			.input(z.object({ conversationId: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				const [conv] = await ctx.db
					.select({ transcriptSegments: conversations.transcriptSegments })
					.from(conversations)
					.where(
						and(
							eq(conversations.id, input.conversationId),
							eq(conversations.userId, ctx.userId),
						),
					);
				if (!conv) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No conversation with that id",
					});
				}
				// Nothing to analyze: a NULL/empty transcript (e.g. an STT-failed conv) is a
				// panel dead-end re-analyze can't recover. The worker's empty-transcript guard
				// is the defensive backstop; this is the user-facing refusal.
				if (!conv.transcriptSegments || conv.transcriptSegments.length === 0) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Conversation has no transcript to re-analyze",
					});
				}

				// One re-analyze at a time per conversation: an in-flight (pending/analyzing)
				// reanalyze job → CONFLICT (the UI also disables the button). Prevents a
				// double-click from racing two jobs onto the same conversation.
				const inFlight = await ctx.db
					.select({ id: processingJobs.id })
					.from(processingJobs)
					.where(
						and(
							eq(processingJobs.userId, ctx.userId),
							eq(processingJobs.conversationId, input.conversationId),
							eq(processingJobs.kind, "reanalyze"),
							inArray(processingJobs.status, ["pending", "analyzing"]),
						),
					);
				if (inFlight.length > 0) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "A re-analysis is already in progress",
					});
				}

				const jobId = crypto.randomUUID();
				await ctx.db.insert(processingJobs).values({
					id: jobId,
					userId: ctx.userId,
					conversationId: input.conversationId,
					status: "pending",
					kind: "reanalyze",
				});

				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "conversation.reanalyze_requested",
						userId: ctx.userId,
						conversationId: input.conversationId,
						jobId,
					}),
				);
				// Fire-and-forget kickoff through the injected seam (default:
				// reanalyzeKickoff → the worker's atomic claim). Funnels through the same
				// claim as the poller, so the two can never both process this job.
				deps.onReanalyze(jobId, ctx.db);
				return { ok: true as const };
			}),
	});
}

export const conversationsRouter = createConversationsRouter();
