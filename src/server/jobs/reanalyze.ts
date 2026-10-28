/**
 * Re-analyze job worker (S-06 `transcript-edit-and-reanalyze`, FR-020/FR-021).
 *
 * A SECOND, transcript-sourced durable job kind that runs ALONGSIDE the audio-first
 * `processJob` (`worker.ts`). Where `processJob` starts from a Twilio recording and
 * is mandatory-STT, `reanalyzeJob` starts from the ALREADY-PERSISTED transcript
 * (the user's edit, or a backstopped failed/refused transcript) and re-runs ONLY
 * `analyze()` + the override-guarded `classify()`. It NEVER touches STT, the
 * recording, or `transcriptSegments` — reusing the worker would re-transcribe
 * deleted audio, clobber the edit, and wipe user-edited tags (frame brief).
 *
 * Two guarantees distinguish this path from the first-run worker:
 *
 *  1. **Success-only persist.** The conversation row is mutated in ONE transaction
 *     that is the LAST step, run only after `analyze()`/`classify()` succeed. Any
 *     earlier throw leaves the prior analysis/tags/classification untouched; the
 *     catch block updates ONLY `processing_jobs`. A re-analyze that fails is a
 *     no-op on the user's existing data (FR-021 non-destructive recovery).
 *  2. **Per-tag merge** (not the first-run destructive clobber). User-edited tags
 *     (`is_user_edited=true`) survive; only auto (`is_user_edited=false`) tags are
 *     regenerated; a regenerated candidate that collides with a surviving
 *     user-edited name is skipped.
 *
 * Reuses the `WorkerDeps` shape (`db`/`analyze`/`classify`/`now` are used;
 * `telephony`/`stt`/`sttMode` are simply unused here) so the kickoff/poller wiring
 * and `defaultWorkerDeps()` are shared verbatim.
 */
import { and, eq } from "drizzle-orm";

import {
	ProviderError,
	RETRYABLE_PROVIDER_ERROR_CODES,
} from "~/server/_lib/provider-error";
import { conversations, processingJobs, projects } from "~/server/db/schema";
import { logJobEvent } from "~/server/jobs/audit";
import { claimJob } from "~/server/jobs/claim";
import { loadPromptVocabulary } from "~/server/jobs/vocabulary";
import {
	backoff,
	errorCode,
	errorMessage,
	joinTranscript,
	MAX_ATTEMPTS,
	type WorkerDeps,
} from "~/server/jobs/worker";
import type { Project } from "~/server/llm/classify";
import { type Classification, categorySchema } from "~/server/llm/schemas";
import type { TranscriptSegment } from "~/server/stt/types";
import { reconcileTags } from "~/server/tags/reconcile";

/**
 * Process a single re-analyze job. Atomically claims it (`status='pending' AND
 * kind='reanalyze'`); a zero-row claim (lost the race / not pending / wrong kind)
 * is a no-op. On success the prior analysis is replaced; on ANY failure the prior
 * analysis is preserved and only the job row is updated (retry or dead-letter).
 */
export async function reanalyzeJob(
	jobId: string,
	deps: WorkerDeps,
): Promise<void> {
	const now = deps.now ?? (() => new Date());

	// Atomic claim + attempt increment, scoped to `kind='reanalyze'` so this worker
	// can NEVER claim a first-run `analyze` job (and the poller dispatch is symmetric).
	// Shared with `processJob` — see `claim.ts`.
	const job = await claimJob(deps.db, jobId, {
		kind: "reanalyze",
		toStatus: "analyzing",
	});
	if (!job) return; // lost the claim race, not pending, or not a reanalyze job.

	logJobEvent({
		event: "job.reanalyze_claimed",
		jobId,
		conversationId: job.conversationId,
		status: "analyzing",
		attemptCount: job.attemptCount,
	});

	try {
		// Read the persisted transcript + the override flags. The transcript is the
		// SOURCE (edited or backstopped) — we never re-transcribe.
		const [conv] = await deps.db
			.select({
				transcriptSegments: conversations.transcriptSegments,
				categoryOverridden: conversations.categoryOverridden,
				projectOverridden: conversations.projectOverridden,
			})
			.from(conversations)
			.where(eq(conversations.id, job.conversationId));

		const segments: TranscriptSegment[] = conv?.transcriptSegments ?? [];
		// Defensive: the `reanalyze` mutation gates on a non-empty transcript, so an
		// empty one here means a race (transcript cleared between enqueue and claim)
		// or corruption. Non-retryable — there is nothing to analyze.
		if (segments.length === 0) {
			throw new ProviderError({
				code: "invalid_response",
				message: "reanalyze job has an empty transcript — nothing to analyze",
			});
		}

		const transcriptText = joinTranscript(segments);

		// --- tag vocabulary (phase 5) ---
		// Read in THIS pipeline too, not only the first-run one: an edit-triggered
		// re-analysis that ran without the dictionary would re-coin the variant
		// names a merge had just consolidated, so every transcript edit would quietly
		// undo the cleanup. Outside the closing transaction, degrading to empty on
		// failure — see `vocabulary.ts`.
		const vocabulary = await loadPromptVocabulary(deps.db, {
			userId: job.userId,
			jobId,
			conversationId: job.conversationId,
		});

		const analysis = await deps.analyze({
			transcript: transcriptText,
			vocabulary,
		});

		// --- classify (FR-005), override-guarded (identical guard to worker.ts) ---
		// If the user already owns the classification (EITHER flag set), skip auto-fill
		// entirely — re-analyze must NEVER overwrite a user-chosen category/project
		// (FR-021). Otherwise re-classify against the current project list. A
		// `no_auto_assignment` / empty-list / short-circuit leaves the columns
		// untouched (NOT nulled). A `ProviderError` propagates to the catch below.
		const userOwnsClassification =
			conv?.categoryOverridden === true || conv?.projectOverridden === true;
		let autoClassification: Classification | null = null;
		if (!userOwnsClassification) {
			const projectRows = await deps.db
				.select({
					id: projects.id,
					name: projects.name,
					category: projects.category,
				})
				.from(projects)
				.where(eq(projects.userId, job.userId));
			// safeParse (not parse): a malformed category row (hand-edited migration /
			// emergency SSH INSERT) is skipped, never throws a ZodError into the catch.
			const projectList: Project[] = [];
			for (const p of projectRows) {
				const parsed = categorySchema.safeParse(p.category);
				if (!parsed.success) {
					logJobEvent({
						event: "job.reanalyze_invalid_project_skipped",
						jobId,
						conversationId: job.conversationId,
					});
					continue;
				}
				projectList.push({ id: p.id, name: p.name, category: parsed.data });
			}
			if (projectList.length > 0) {
				const result = await deps.classify({
					transcript: transcriptText,
					projects: projectList,
				});
				if (result.status === "classified") {
					autoClassification = result.classification;
				}
			}
		}

		// --- success-only persist (the LAST step; runs only after analyze/classify) ---
		// Replaces the analysis, conditionally the classification, stamps reanalyzed_at,
		// merges tags, and flips the job to done — all atomically. transcriptSegments is
		// NEVER written here (the user's edit is the source, not an output).
		await deps.db.transaction(async (tx) => {
			await tx
				.update(conversations)
				.set({
					analysis,
					reanalyzedAt: now(),
					...(autoClassification
						? {
								category: autoClassification.category,
								projectId: autoClassification.projectId,
							}
						: {}),
				})
				.where(eq(conversations.id, job.conversationId));

			// --- per-tag merge (NOT the first-run destructive clobber) ---
			// Keep user-edited tags; regenerate only auto tags; skip a candidate whose
			// canonical name collides with a surviving user-edited name. The mechanics
			// (and the canonical-storage INVARIANT they depend on) live in the shared
			// reconciler — this call site states only WHICH policy re-analysis needs.
			await reconcileTags(tx, {
				userId: job.userId,
				conversationId: job.conversationId,
				candidates: analysis.candidateTags,
				policy: "merge",
			});

			await tx
				.update(processingJobs)
				.set({ status: "done" })
				.where(eq(processingJobs.id, jobId));
		});

		logJobEvent({
			event: "job.reanalyze_done",
			jobId,
			conversationId: job.conversationId,
			status: "done",
		});
	} catch (err) {
		// Retryable + under the cap → re-enqueue with backoff; else dead-letter. This
		// block updates ONLY `processing_jobs` — the conversation's existing analysis,
		// tags, and classification are NEVER touched on a re-analyze failure (FR-021).
		const retryable =
			err instanceof ProviderError &&
			RETRYABLE_PROVIDER_ERROR_CODES.has(err.code);
		if (retryable && job.attemptCount < MAX_ATTEMPTS) {
			await deps.db
				.update(processingJobs)
				.set({
					status: "pending",
					nextRetryAt: new Date(now().getTime() + backoff(job.attemptCount)),
					lastError: errorMessage(err),
					lastErrorCode: errorCode(err),
				})
				.where(eq(processingJobs.id, jobId));
			logJobEvent({
				event: "job.reanalyze_retry",
				jobId,
				conversationId: job.conversationId,
				status: "pending",
				attemptCount: job.attemptCount,
				errorCode: errorCode(err),
			});
		} else {
			await deps.db
				.update(processingJobs)
				.set({
					status: "failed",
					lastError: errorMessage(err),
					lastErrorCode: errorCode(err),
				})
				.where(eq(processingJobs.id, jobId));
			logJobEvent({
				event: "job.reanalyze_failed",
				jobId,
				conversationId: job.conversationId,
				status: "failed",
				attemptCount: job.attemptCount,
				errorCode: errorCode(err),
			});
		}
	}
}

/**
 * Fire-and-forget entry used by the `conversations.reanalyze` mutation fast-path,
 * mirroring `worker.ts` `kickoff`. Funnels through the same atomic claim as the
 * poller, so the two can never both process one job. The `.catch` is the
 * last-resort net: `reanalyzeJob` handles its own pipeline errors, so this only
 * fires if the claim/select SQL itself throws — dead-letter a row still owned by
 * THIS attempt (`analyzing`) rather than leak an unhandled rejection.
 */
export function reanalyzeKickoff(jobId: string, deps: WorkerDeps): void {
	void reanalyzeJob(jobId, deps).catch(async (err) => {
		logJobEvent({
			event: "job.reanalyze_kickoff_crashed",
			jobId,
			error: errorMessage(err),
		});
		try {
			await deps.db
				.update(processingJobs)
				.set({
					status: "failed",
					lastError: errorMessage(err),
					lastErrorCode: errorCode(err),
				})
				.where(
					and(
						eq(processingJobs.id, jobId),
						eq(processingJobs.status, "analyzing"),
					),
				);
		} catch {
			// swallow — nothing more we can safely do off the request path.
		}
	});
}
