import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { processingJobs } from "~/server/db/schema";
import { logJobEvent } from "~/server/jobs/audit";
import { resolveJobHandler } from "~/server/jobs/registry";
import { defaultWorkerDeps, type WorkerDeps } from "~/server/jobs/worker";

/**
 * Failure-ops surface (Phase 5 of `call-to-analysis-pipeline`). Makes the FR-006
 * dead-letter inspectable (`listFailed`) and replayable (`replay`) without UI —
 * ready for the panel (FR-012) to bind to later. Both procedures are
 * `protectedProcedure` (session-gated) and filter on `ctx.userId` even though it
 * is the constant `'me'`, keeping the call sites multi-user-shaped from line one.
 *
 * `replay`'s side effect (re-running the worker) is injected via `onReplay` so the
 * router is unit-testable against a spy + throwaway DB — same DI rationale as
 * `webhooks.ts`. The production default funnels through the matching worker's
 * atomic claim, built against the request-scoped `ctx.db`.
 *
 * `onReplay` takes the job's `kind` because the dead-letter holds BOTH pipelines:
 * an audio-first `analyze` job and a transcript-sourced `reanalyze` job. Starting
 * the wrong one is destructive (the audio path re-transcribes deleted audio and
 * clobbers the user's edited transcript + user-edited tags), so replay routes by
 * the kind it read from the row rather than assuming the audio path.
 */
export type JobsRouterDeps = {
	onReplay: (jobId: string, db: WorkerDeps["db"], kind: string) => void;
};

const DEFAULT_DEPS: JobsRouterDeps = {
	// Dispatch by kind through the registry — this router names no specific worker
	// module. An unrecognized kind resolves to the audio-first handler, whose
	// kind-scoped claim then matches zero rows: a safe no-op, never a
	// wrong-pipeline run (see `registry.ts`).
	onReplay: (jobId, db, kind) =>
		resolveJobHandler(kind).kickoff(jobId, defaultWorkerDeps(db)),
};

export function createJobsRouter(deps: JobsRouterDeps = DEFAULT_DEPS) {
	return createTRPCRouter({
		// Failed jobs for this user, newest first. Serves the FR-006 dead-letter view.
		// Bounded (F2): a poison-pill loop or provider outage could pile up many failed
		// rows; cap the load so the 256 MB Machine never materializes an unbounded set
		// (and the future FR-012 panel binds against a sane page). 100 is far above any
		// realistic single-user dead-letter; promote to a paginated input if it's ever hit.
		listFailed: protectedProcedure.query(({ ctx }) =>
			ctx.db.query.processingJobs.findMany({
				where: and(
					eq(processingJobs.status, "failed"),
					eq(processingJobs.userId, ctx.userId),
				),
				orderBy: desc(processingJobs.updatedAt),
				limit: 100,
			}),
		),

		// Reset a failed job back to the head of the queue and re-kick it. The
		// status='failed' guard in the WHERE makes this a no-op (→ NOT_FOUND) for a
		// job that is not actually in the dead-letter, so a stale/duplicate replay
		// can't disturb a running or already-succeeded job.
		replay: protectedProcedure
			.input(z.object({ jobId: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				const reset = await ctx.db
					.update(processingJobs)
					.set({
						status: "pending",
						attemptCount: 0,
						nextRetryAt: null,
						lastError: null,
						lastErrorCode: null,
					})
					.where(
						and(
							eq(processingJobs.id, input.jobId),
							eq(processingJobs.userId, ctx.userId),
							eq(processingJobs.status, "failed"),
						),
					)
					.returning({ id: processingJobs.id, kind: processingJobs.kind });

				const job = reset[0];
				if (!job) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No failed job with that id",
					});
				}

				// `kind` is on the audit line so `fly logs` shows WHICH pipeline a replay
				// started — the only observable that distinguishes the two paths in prod.
				logJobEvent({
					event: "job.replay",
					jobId: input.jobId,
					status: "pending",
					kind: job.kind,
				});
				deps.onReplay(input.jobId, ctx.db, job.kind);
				return { ok: true as const };
			}),
	});
}

export const jobsRouter = createJobsRouter();
