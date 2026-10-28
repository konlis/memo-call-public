/**
 * The one ranked-tag query (`tag-vocabulary-control`, phase 3).
 *
 * Every consumer that needs "the user's tags, by how often they are used" reads
 * it from here: the list view's tag cloud (via `tags.listWithCounts`), the
 * global merge picker (phase 4) and the vocabulary injected into the
 * `analyze()` prompt (phase 5, called from `worker.ts` / `reanalyze.ts`).
 *
 * It is a module function, NOT a router procedure, for the same reason
 * `reconcile.ts` is one: the workers have no tRPC context, and "the same
 * query" written a second time in a worker would be a second copy of the
 * ranking rule — the class of drift CLAUDE.md forbids for the reconcile
 * policies. Takes a db (or transaction) handle and the userId explicitly, so
 * every call site stays multi-user-shaped even while `userId` is the constant
 * `'me'`.
 *
 * NO visibility threshold lives here. The query returns EVERY name, including
 * the once-used ones; the ≥2 cutoff is a presentation rule (the list view
 * applies it) because phases 4 and 5 need the whole picture — merging is
 * precisely about the long tail, and the prompt vocabulary takes its own
 * "≥2 uses, at most 40" slice.
 */
import { asc, count, desc, eq, sql } from "drizzle-orm";

import type { db as dbSingleton } from "~/server/db";
import { tags } from "~/server/db/schema";

/**
 * A db handle OR the transaction handle both workers hold. Type-only, derived
 * from the singleton rather than drizzle internals (mirrors `reconcile.ts`'s
 * `TagTx`), so this module stays a leaf.
 */
export type TagReader = Pick<typeof dbSingleton, "select">;

export type RankedTag = {
	/** Canonical tag name (`normalizeTag` form — the only form the table holds). */
	name: string;
	/** Number of conversations carrying the tag (one row per conversation). */
	count: number;
	/** True when ANY row with this name was set/renamed by the user. */
	isUserEdited: boolean;
};

/**
 * Distinct tag names for `userId` with their usage count, most used first;
 * ties broken by name ascending so the order is total (a given table state
 * yields ONE list, which the UI's trim-to-N and the prompt's top-N depend on).
 *
 * Served by `tag_user_name_idx` (user_id, name): the WHERE consumes the index
 * prefix and the GROUP BY reads the rest already sorted by name.
 */
export async function listTagsWithCounts(
	db: TagReader,
	opts: { userId: string },
): Promise<RankedTag[]> {
	const rows = await db
		.select({
			name: tags.name,
			count: count(),
			// `is_user_edited` is a 0/1 integer on disk, so `max()` over the group
			// is "any row edited". A raw `sql` select bypasses the column's boolean
			// decoder, hence the explicit mapping below.
			anyEdited: sql<number>`max(${tags.isUserEdited})`,
		})
		.from(tags)
		.where(eq(tags.userId, opts.userId))
		.groupBy(tags.name)
		.orderBy(desc(count()), asc(tags.name));

	return rows.map((r) => ({
		name: r.name,
		count: r.count,
		isUserEdited: Number(r.anyEdited) > 0,
	}));
}
