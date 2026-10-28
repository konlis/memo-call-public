import { safeErrorMessage } from "~/server/_lib/redact";

/**
 * Per-job structured audit logging (Phase 5 of `call-to-analysis-pipeline`).
 *
 * One `console.error` JSON line per job transition, mirroring the F-03 auth audit
 * convention (`src/server/auth/audit.ts`). Stderr (NOT stdout) keeps the audit
 * channel distinguishable from the `[TRPC]`/request-timing logs, and the lines
 * are visible in `fly logs` via `grep '"event":"job.…"'`. No DB audit table —
 * retention is Fly's log window (~7 days), same as auth.
 */
export type JobAuditFields = {
	/**
	 * The event name. Typed `string`, so this list is documentation, not
	 * enforcement — and it is the only inventory of what to grep for in
	 * `fly logs`, which is the ONLY place these lines live (~7-day window, no DB
	 * audit table). It had drifted to 8 of the 22 names actually emitted; the
	 * missing ones included `job.vocabulary_unavailable`, which a runbook tells
	 * an operator to grep for. Regenerate rather than hand-patch:
	 *
	 *   grep -rhno '"job\.[a-z_]*"' src/server --include=*.ts \
	 *     | sed 's/.*"job/job/' | tr -d '"' | sort -u
	 *
	 * First-run pipeline (`worker.ts`):
	 *   `job.enqueued | job.claimed | job.analyzing | job.done | job.retry |
	 *    job.refused | job.failed | job.replay | job.kickoff_crashed |
	 *    job.invalid_project_skipped | job.vocabulary_unavailable |
	 *    job.recording_deleted | job.recording_delete_failed`
	 * Re-analyze pipeline (`reanalyze.ts`):
	 *   `job.reanalyze_claimed | job.reanalyze_done | job.reanalyze_retry |
	 *    job.reanalyze_failed | job.reanalyze_kickoff_crashed |
	 *    job.reanalyze_invalid_project_skipped | job.vocabulary_unavailable`
	 * Scheduler / sweeps (`scheduler.ts`):
	 *   `job.poll_tick_failed | job.unknown_kind_skipped | job.delete_sweep_failed`
	 */
	event: string;
	jobId: string;
	conversationId?: string;
	status?: string;
	/** Which pipeline a job belongs to (`analyze` | `reanalyze`) — set on `job.replay`. */
	kind?: string;
	attemptCount?: number;
	errorCode?: string;
	error?: string;
};

export function logJobEvent(fields: JobAuditFields): void {
	// Defence in depth: `error` is expected to arrive through `safeErrorMessage`
	// already, but a caller handing over raw text must still not put a phone
	// number or a caller-id into the log window (FR-025), and a non-string
	// smuggled through a cast must not make the logger throw (F1). Spread-then-
	// override keeps the field in its original key position.
	console.error(
		JSON.stringify({
			ts: Date.now(),
			...fields,
			...(fields.error === undefined
				? {}
				: { error: safeErrorMessage(fields.error) }),
		}),
	);
}
