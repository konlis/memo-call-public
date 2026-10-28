/**
 * The one tag-set reconciler (Phase 5 of `refactor-opportunities`, K-1).
 *
 * Both job workers finish by bringing a conversation's tag set in line with a
 * fresh candidate list from `analyze()`. They used to do it twice, differently:
 * `worker.ts` deleted EVERY tag for the conversation and re-inserted; `reanalyze.ts`
 * kept `is_user_edited=true` rows and regenerated only the auto ones. That
 * divergence was not an accident — it is a real policy difference (a first run has
 * no user work to protect; a re-analysis does) — but it lived as two independent
 * implementations, which is how the Phase 1 data-loss hole was born one layer up:
 * the destructive write's safety rested on a premise about its callers
 * (`jobs.replay` × `kind='reanalyze'` broke that premise).
 *
 * So the policy stays, but it becomes an ARGUMENT rather than a second copy:
 *
 *  - `"replace-all"` — first run / replay: no tag on this conversation is the
 *    user's, so all of them are replaced by the fresh candidates.
 *  - `"merge"` — re-analysis: `is_user_edited=true` rows survive, `false` rows are
 *    regenerated, and a candidate colliding with a survivor is skipped.
 *
 * Takes the TRANSACTION handle, not a db client: both call sites run inside the
 * done-transaction, and the tag write must stay atomic with the analysis write and
 * the `status='done'` flip. Accepting a client would make it possible to write tags
 * outside that unit.
 *
 * The `tags` router (`api/routers/tags.ts`) is deliberately NOT a caller — it does
 * single-tag user operations with their own TRPCError mapping, not set
 * reconciliation.
 */
import { and, eq } from "drizzle-orm";

import type { db as dbSingleton } from "~/server/db";
import { tags } from "~/server/db/schema";
import { normalizeTags } from "~/server/tags/normalize";

/**
 * Which rows survive a reconcile.
 *
 *  - `replace-all`: none — every tag for the conversation is deleted first.
 *  - `merge`: the user-edited ones.
 */
export type TagPolicy = "replace-all" | "merge";

/**
 * The transaction handle both workers already hold. Derived from the db singleton
 * rather than imported from drizzle internals, and type-only, so this module stays
 * a leaf (mirrors `jobs/claim.ts`).
 */
export type TagTx = Parameters<
	Parameters<typeof dbSingleton.transaction>[0]
>[0];

/**
 * Bring a conversation's tag set in line with `candidates` under `policy`.
 *
 * Candidates are normalized to canonical form and de-duped HERE (write-time) via
 * the shared `normalizeTags`, so the `tags` table — the UI's editable read source —
 * only ever holds canonical `is_user_edited=false` rows (the immutable
 * `analysis.candidateTags` JSON keeps the raw LLM record). Empties are dropped and
 * collisions collapse, so the insert count can be < `candidates.length`.
 *
 * INVARIANT (`merge` only): the collision skip compares the canonical candidate
 * names against RAW survivor names, so it is correct ONLY because user-edited tags
 * are stored in canonical form (the tags router normalizes on write, S-05). If a
 * future path ever persists a non-canonical user-edited tag, the check misses the
 * collision and inserts a near-duplicate auto row. Pinned by `reanalyze.test.ts`
 * ("merge DEPENDS on user-edited tags being stored canonically") and by
 * `reconcile.test.ts` — deliberately carried over as-is by the extraction, not
 * silently "fixed" along the way.
 *
 * Every statement is scoped on `userId` as well as `conversationId` — multi-user-
 * shaped call sites per CLAUDE.md, even though `userId` is the constant `'me'`
 * today. (The `replace-all` path gained that predicate in this extraction; the
 * merge path always had it.)
 *
 * Returns the canonical names actually inserted.
 */
export async function reconcileTags(
	tx: TagTx,
	opts: {
		userId: string;
		conversationId: string;
		candidates: string[];
		policy: TagPolicy;
	},
): Promise<string[]> {
	const { userId, conversationId, candidates, policy } = opts;

	// `merge` keeps the user's rows and must know their names BEFORE the delete, so
	// a regenerated candidate can be skipped instead of duplicating one.
	// `replace-all` has no survivors by definition.
	const survivorNames = new Set<string>();
	if (policy === "merge") {
		const survivors = await tx
			.select({ name: tags.name })
			.from(tags)
			.where(
				and(
					eq(tags.userId, userId),
					eq(tags.conversationId, conversationId),
					eq(tags.isUserEdited, true),
				),
			);
		for (const s of survivors) survivorNames.add(s.name);
	}

	await tx.delete(tags).where(
		and(
			eq(tags.userId, userId),
			eq(tags.conversationId, conversationId),
			// The ONLY difference in the delete: `merge` spares the user-edited rows.
			// `and` drops `undefined` operands, so `replace-all` emits the two-predicate
			// WHERE verbatim.
			policy === "merge" ? eq(tags.isUserEdited, false) : undefined,
		),
	);

	const inserted: string[] = [];
	for (const name of normalizeTags(candidates)) {
		if (survivorNames.has(name)) continue; // a user-edited tag already owns it
		await tx.insert(tags).values({
			id: crypto.randomUUID(),
			userId,
			conversationId,
			name,
			isUserEdited: false,
		});
		inserted.push(name);
	}
	return inserted;
}
