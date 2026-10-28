/**
 * The one atomic job claim (Phase 2 of `refactor-opportunities`, K-4).
 *
 * Both workers advance a `processing_jobs` row out of `pending` with the same
 * DB-level compare-and-swap; they differ only in the `kind` they accept and the
 * status they move to. They used to hand-write it twice — and that duplication is
 * exactly how the Phase 1 defect was born: `reanalyzeJob`'s claim was scoped to
 * `kind='reanalyze'` while `processJob`'s claim had no `kind` predicate at all, so
 * a re-analyze job replayed through `jobs.replay` ran the audio-first pipeline.
 * One helper means a future third kind cannot ship with a subtly different claim.
 *
 * The compare-and-swap is the ONLY concurrency guard in the system: SQLite
 * serializes writers, so exactly one caller (a webhook fast-path kickoff OR a
 * poller tick) wins the row and every other caller gets zero rows back. This also
 * holds if >1 Machine runs transiently during a deploy.
 *
 * Deliberately dependency-free with respect to the rest of `src/server/jobs/`:
 * `db` is typed off the `~/server/db` singleton rather than `WorkerDeps["db"]`
 * (the two are the same type) so that `worker.ts` → `claim.ts` stays acyclic —
 * `tsPreCompilationDeps` is on in `.dependency-cruiser.cjs`, so even a type-only
 * import back to `worker.ts` would trip `no-circular`.
 */
import { and, eq, sql } from "drizzle-orm";

import type { db as dbSingleton } from "~/server/db";
import { processingJobs } from "~/server/db/schema";

/**
 * The job pipelines that exist. Each worker claims its own kind and only its own.
 * Lives here (the leaf module) rather than in the dispatch registry so the claim
 * can be typed without importing anything that imports a worker.
 */
export type JobKind = "analyze" | "reanalyze";

/** The in-flight status a claim moves a job into — one per pipeline's first step. */
export type ClaimedStatus = "transcribing" | "analyzing";

/** The projection both workers need off a won claim. */
export type ClaimedJob = {
	id: string;
	userId: string;
	conversationId: string;
	attemptCount: number;
};

/**
 * Atomically claim `jobId` for `kind`, moving it to `toStatus` and burning one
 * attempt. Returns the claimed row, or `undefined` when the claim was lost — the
 * row is not `pending` (another runner owns it, or it is terminal) or it belongs
 * to a different pipeline. Callers treat `undefined` as a plain no-op.
 *
 * The `kind` predicate needs no migration: the column is `text DEFAULT 'analyze'
 * NOT NULL` and `drizzle/0002` backfilled every pre-existing row.
 */
export async function claimJob(
	db: typeof dbSingleton,
	jobId: string,
	opts: { kind: JobKind; toStatus: ClaimedStatus },
): Promise<ClaimedJob | undefined> {
	const claimed = await db
		.update(processingJobs)
		.set({
			status: opts.toStatus,
			attemptCount: sql`${processingJobs.attemptCount} + 1`,
		})
		.where(
			and(
				eq(processingJobs.id, jobId),
				eq(processingJobs.status, "pending"),
				eq(processingJobs.kind, opts.kind),
			),
		)
		.returning({
			id: processingJobs.id,
			userId: processingJobs.userId,
			conversationId: processingJobs.conversationId,
			attemptCount: processingJobs.attemptCount,
		});

	return claimed[0];
}
