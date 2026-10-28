/**
 * Job-kind → handler registry (Phase 3 of `refactor-opportunities`, K-4).
 *
 * The single source of dispatch truth: "which `kind` runs which pipeline" is
 * stated here once, instead of being re-derived by an `if` in the scheduler and
 * an inline branch in each router. Adding a third kind is one entry here plus its
 * own worker — not edits across a scheduler, two routers, and two claim sites.
 *
 * **Direction of dependency is load-bearing.** This module imports the workers;
 * `scheduler.ts`, `jobs.ts` and `conversations.ts` import this module. A worker
 * importing the registry closes a cycle and gives "which kind runs which
 * pipeline" a second home — the duplication this module exists to remove. The
 * workers do NOT need it: each passes its own kind to `claimJob`, which states
 * which kind *it* handles, not which kinds exist.
 *
 * Enforced by the `no-worker-to-registry` rule in `.dependency-cruiser.cjs`,
 * severity **error**. Do NOT rely on `no-circular` for this: it is severity
 * `warn`, and depcruise exits 0 on warnings — with no CI in this repo, such a
 * cycle would ship with every local gate green (verified empirically during the
 * Phases 2–4 impl-review).
 *
 * The kind vocabulary itself lives in `claim.ts` (the leaf module) and is
 * re-exported here, so the claim can be typed without importing anything that
 * imports a worker.
 */
import type { JobKind } from "~/server/jobs/claim";
import { reanalyzeJob, reanalyzeKickoff } from "~/server/jobs/reanalyze";
import { kickoff, processJob, type WorkerDeps } from "~/server/jobs/worker";

export type { JobKind };

/**
 * The two entry points every pipeline exposes:
 *  - `run` — awaitable, used by the poller (which processes one job per tick).
 *  - `kickoff` — fire-and-forget with a last-resort dead-letter catch, used off
 *    the request path (a webhook fast-path or a tRPC mutation).
 */
export type JobHandler = {
	run: (jobId: string, deps: WorkerDeps) => Promise<void>;
	kickoff: (jobId: string, deps: WorkerDeps) => void;
};

export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
	analyze: { run: processJob, kickoff },
	reanalyze: { run: reanalyzeJob, kickoff: reanalyzeKickoff },
};

/**
 * Every dispatchable kind. Used as a query predicate so the poller can skip rows
 * it could never dispatch — see `pollOnce`.
 */
export const JOB_KINDS = Object.keys(JOB_HANDLERS) as JobKind[];

/** The kind an unrecognized column value degrades to — mirrors the column default. */
export const DEFAULT_JOB_KIND: JobKind = "analyze";

/**
 * Narrowing guard for the raw `processing_jobs.kind` text column.
 *
 * `Object.hasOwn`, NOT `kind in JOB_HANDLERS`: `in` walks the prototype chain, so
 * `"toString"` would report as a valid kind and `resolveJobHandler` would return
 * `Object.prototype.toString` — a function with no `.run`/`.kickoff`, i.e. a
 * `TypeError` on the request path, in exactly the corrupt-column case the
 * fallback exists to survive. Caught by `registry.test.ts`.
 */
export function isJobKind(kind: string): kind is JobKind {
	return Object.hasOwn(JOB_HANDLERS, kind);
}

/**
 * Resolve a raw `kind` column value to its handler. An unrecognized value falls
 * back to `DEFAULT_JOB_KIND` rather than throwing, so a corrupt row can never
 * take down a request path.
 *
 * **What the fallback actually does** (the honest version — the plan originally
 * described it as "degrades exactly as today"): it selects the audio-first
 * handler, whose claim is scoped to `kind='analyze'` and will therefore match
 * zero rows for a foreign kind. So the fallback is a safe **no-op**, not a
 * wrong-pipeline run. That is the desired degradation — but it also means the
 * fallback cannot rescue such a row, which is why `pollOnce` filters unknown
 * kinds out of its queue rather than relying on this.
 */
export function resolveJobHandler(kind: string): JobHandler {
	return isJobKind(kind) ? JOB_HANDLERS[kind] : JOB_HANDLERS[DEFAULT_JOB_KIND];
}
