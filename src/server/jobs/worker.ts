/**
 * Durable job worker (Phase 4 of `call-to-analysis-pipeline`).
 *
 * `processJob` advances one `processing_jobs` row through the pipeline state
 * machine — `pending → transcribing → analyzing → done` (terminal success) or
 * `→ failed` (terminal dead-letter, replayable). Durability lives in the DB, not
 * the runtime: the job *Promise* is disposable; the row + the boot sweep + the
 * poller (see `scheduler.ts`) are the durable unit.
 *
 * Concurrency is guarded by ONE atomic claim — not an in-module flag. The claim
 * itself lives in `claim.ts` (shared with the re-analyze worker) and is scoped on
 * BOTH axes: `status='pending'` AND `kind='analyze'`. SQLite serializes writers,
 * so exactly one claimant (the webhook fast-path kickoff OR a poller tick) wins
 * the row; every other caller gets zero rows and returns. This also makes the
 * design safe if >1 Machine runs transiently during a deploy. The `kind` half is
 * what stops a re-analyze job from ever entering this audio-first pipeline — see
 * `processJob`'s doc for why that matters.
 *
 * Side-effecting collaborators (`db`, `telephony`, `stt`, `analyze`) are injected
 * via `WorkerDeps` so the worker is unit-testable against a throwaway libsql DB
 * (mirrors the `webhooks.ts` ← `route.ts` split). `defaultWorkerDeps()` wires the
 * production singletons.
 */
import { and, eq, inArray } from "drizzle-orm";

import { env } from "~/env";
import {
	ProviderError,
	RETRYABLE_PROVIDER_ERROR_CODES,
} from "~/server/_lib/provider-error";
import { safeErrorMessage } from "~/server/_lib/redact";
import { db as dbSingleton } from "~/server/db";
import { conversations, processingJobs, projects } from "~/server/db/schema";
import { logJobEvent } from "~/server/jobs/audit";
import { claimJob } from "~/server/jobs/claim";
import { loadPromptVocabulary } from "~/server/jobs/vocabulary";
import {
	type AnalyzeInput,
	analyze as analyzeService,
} from "~/server/llm/analyze";
import {
	type ClassifyInput,
	type ClassifyResult,
	classify as classifyService,
	type Project,
} from "~/server/llm/classify";
import {
	type Analysis,
	type Classification,
	categorySchema,
} from "~/server/llm/schemas";
import { stt as sttSingleton } from "~/server/stt";
import type {
	AudioSource,
	SttProvider,
	TranscriptResult,
} from "~/server/stt/types";
import { reconcileTags } from "~/server/tags/reconcile";
import { telephony as telephonySingleton } from "~/server/telephony";
import type { TelephonyProvider } from "~/server/telephony/types";

/** FR-006: a job is retried until it has been *claimed* this many times. */
export const MAX_ATTEMPTS = 5;

/**
 * Progressive backoff in milliseconds: `min(2^n, 60) * 1000`, capped at 60 s.
 * Pure + exported so it is unit-testable in isolation. `n` is the (post-claim)
 * attempt count, so the first retry waits 2 s, then 4, 8, 16, 32, then 60.
 */
export function backoff(attemptCount: number): number {
	return Math.min(2 ** attemptCount, 60) * 1000;
}

export type WorkerDeps = {
	db: typeof dbSingleton;
	telephony: Pick<
		TelephonyProvider,
		| "streamRecording"
		| "deleteRecording"
		| "recordingContentType"
		// Capture reconciliation (`scheduler.ts` → `runReconcileSweep`). OPTIONAL on
		// the interface and it stays optional through the `Pick`, so a stub that
		// omits it still satisfies `WorkerDeps` — which is the honest shape: mock
		// and Twilio have no reconciliation, and the sweep is a clean no-op for
		// them rather than a failure.
		| "listRecordingsAwaitingCapture"
		// Counterparty resolution (`jobs/counterparty.ts` → `runCounterpartySweep`,
		// FR-025). Same optional idiom: a stub without it still satisfies
		// `WorkerDeps`, and the sweep only expires `pending` rows for such a
		// provider.
		| "resolveCounterparties"
	>;
	stt: Pick<SttProvider, "transcribe">;
	/**
	 * Defaults to the real `analyze()` service (LLM singleton); injectable for
	 * tests. Takes `AnalyzeInput` by name rather than a structural literal, so
	 * adding a field to the service (phase 5 added `vocabulary`) fails the build
	 * at every stub instead of silently letting one drift.
	 */
	analyze: (input: AnalyzeInput) => Promise<Analysis>;
	/**
	 * FR-005 classification (LLM singleton + retry-with-feedback). A pure
	 * transcript+projects→result function — the project-list query stays in
	 * `processJob` (a `db` call). Defaults to the real `classify()` service;
	 * injectable for tests.
	 */
	classify: (input: ClassifyInput) => Promise<ClassifyResult>;
	/** STT provider mode — decides the mock seam vs the real Twilio→Deepgram stream relay. */
	sttMode: typeof env.STT_PROVIDER;
	/** Injectable clock for deterministic `next_retry_at` / `recording_deleted_at`. */
	now?: () => Date;
	/**
	 * Whose rows the sweeps write. A constant `'me'` today (single-user), but
	 * PASSED rather than hardcoded at the write site: the multi-user-ready
	 * invariant in `CLAUDE.md` is that every user-owned INSERT names a `user_id`
	 * it was GIVEN, so the day this stops being a constant exactly one place
	 * changes. Required, not optional-with-a-default — an optional field would
	 * put a second `'me'` literal inside `runReconcileSweep`, which is the thing
	 * the invariant forbids.
	 */
	userId: string;
};

/**
 * Production wiring: the real telephony + STT singletons and the real `analyze()`
 * service. A function (not a const) so importing this module never forces the
 * call sites that only need `processJob`/`kickoff` to resolve the singletons at
 * import time. `dbOverride` lets a tRPC procedure run the worker against its
 * request-scoped `ctx.db` (in production that IS the singleton, so the override
 * is a no-op; in tests it points the kickoff at the throwaway DB).
 */
export function defaultWorkerDeps(dbOverride?: typeof dbSingleton): WorkerDeps {
	return {
		db: dbOverride ?? dbSingleton,
		telephony: telephonySingleton,
		stt: sttSingleton,
		analyze: (input) => analyzeService(input),
		classify: (input) => classifyService(input),
		sttMode: env.STT_PROVIDER,
		userId: "me",
	};
}

/** A `WritableStream` that discards everything — proves the auth'd pull path without buffering. */
function discardSink(): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write() {
			// drop the chunk; mock mode writes nothing, real mode relays elsewhere
		},
	});
}

/**
 * Flatten transcript segments into the plain text `analyze()` consumes. Exported
 * so the re-analyze worker (`reanalyze.ts`) shares the exact joiner instead of
 * duplicating it (both feed `analyze()`/`classify()` the same way).
 */
export function joinTranscript(
	segments: { speaker: string; text: string }[],
): string {
	return segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
}

/**
 * Human-readable error reason, SANITIZED. Exported so `reanalyze.ts` shares one
 * copy. A thin alias over `safeErrorMessage` on purpose: this is what every
 * `last_error` write and every `job.*` audit line in both workers goes through,
 * and `redact-sinks.test.ts` fails the suite if one of them reads `.message`
 * directly instead (FR-025: a failed write that binds the counterparty's number
 * must not carry it into the ~7-day log window). Consequences for
 * `processing_jobs.last_error`: the text is capped at 200 chars (`…` when cut),
 * a `DrizzleQueryError` loses its `params:` tail, and one level of `cause` is
 * appended — so it names WHY a statement failed, not just which one.
 */
export function errorMessage(err: unknown): string {
	return safeErrorMessage(err);
}

/** ProviderError discriminator (or `"unknown"`). Exported so `reanalyze.ts` shares one copy. */
export function errorCode(err: unknown): string {
	return err instanceof ProviderError ? err.code : "unknown";
}

/**
 * Resolve the audio source the STT provider consumes, by provider mode.
 *
 * In mock mode we still drain the real authenticated recording pull (proving the
 * auth'd path works) into a discard sink, then hand the provider a `url`-kind
 * `mock://long` source. The real (Deepgram) branch bridges Twilio → the provider
 * with a single `TransformStream`: it starts `streamRecording` writing into
 * `bridge.writable` — deliberately NOT awaited, because the provider consumes
 * `bridge.readable` as its POST body, so the pull and the upload MUST run
 * concurrently or the stream deadlocks on backpressure (the writer blocks until a
 * reader exists, and the reader is created by the provider's `fetch`). Nothing is
 * staged on disk or buffered on the heap — constant RAM under the 256 MB ceiling.
 *
 * F3 (bridge error propagation): the un-awaited `streamRecording` promise carries
 * a `.catch` that aborts the in-flight provider request via an `AbortController`,
 * passing the original `ProviderError` as the abort reason. `streamRecording`
 * already maps every failure to a `ProviderError` (a mid-stream drop → `transport`,
 * a 401/403 → `auth`), so the provider re-throws that exact code and the worker's
 * retry/dead-letter switch behaves correctly — a transient pull failure retries
 * (FR-006) instead of masking as a generic `unknown` dead-letter. The `.catch`
 * also guarantees no unhandled rejection escapes this function.
 */
async function resolveAudioSource(
	deps: WorkerDeps,
	recordingSid: string | null,
): Promise<AudioSource> {
	if (deps.sttMode === "mock") {
		if (recordingSid) {
			await deps.telephony.streamRecording({ recordingSid }, discardSink());
		}
		return { kind: "url", url: "mock://long" };
	}
	// Real STT: a recording is mandatory — there is no audio to transcribe without
	// it. Non-retryable: surface as `invalid_response`, not a retry loop.
	if (!recordingSid) {
		throw new ProviderError({
			code: "invalid_response",
			message: "real-STT job has no recordingSid — nothing to transcribe",
		});
	}
	// Bridge Twilio (writable sink) → provider (readable body) with one
	// TransformStream. Start the pull but do NOT await it; the provider reads
	// `bridge.readable` as its POST body, so both halves run concurrently.
	const bridge = new TransformStream<Uint8Array>();
	const abort = new AbortController();
	// Pass `abort.signal` into streamRecording so its internal pipeTo is tearable
	// (F1) AND into the provider's fetch (via the returned source's `signal`) so a
	// mid-stream pull failure aborts the POST (F3). One controller drives both.
	void deps.telephony
		.streamRecording({ recordingSid }, bridge.writable, {
			signal: abort.signal,
		})
		.catch((err: unknown) => {
			// streamRecording already wraps every failure in a ProviderError; preserve
			// its code (transport for a mid-stream drop, auth for 401/403) as the abort
			// reason so the provider re-throws it verbatim. Only a non-ProviderError
			// escapee is coerced to retryable `transport`. A teardown abort (F1) lands
			// here too as the signal's reason — harmless, the controller is already aborted.
			const reason =
				err instanceof ProviderError
					? err
					: new ProviderError({
							code: "transport",
							message: "Twilio recording pull failed mid-stream",
							cause: err,
						});
			if (!abort.signal.aborted) abort.abort(reason);
		});
	return {
		kind: "stream",
		open: () => bridge.readable,
		// The MIME type of what `streamRecording` actually pulls — asked of the
		// provider, never assumed here. The job layer has no business knowing
		// which codec the incumbent telephony vendor serves.
		contentType: deps.telephony.recordingContentType,
		signal: abort.signal,
		// F1: the worker calls this in a `finally` around `transcribe`. Aborting the
		// controller is honored by streamRecording's pipeTo (via the signal above),
		// which rejects → the `.catch` runs → the in-flight Twilio pull is torn down
		// instead of dangling on backpressure. On the success path the pull already
		// finished, so the abort is a harmless no-op (guarded by `aborted`).
		cleanup: () => {
			if (!abort.signal.aborted) {
				abort.abort(
					new ProviderError({
						code: "transport",
						message: "STT settled — tearing down recording pull",
					}),
				);
			}
		},
	};
}

/**
 * Process a single job. Atomically claims it first; if the claim returns zero
 * rows, returns immediately. The claim is scoped on BOTH axes:
 *
 *  - `status='pending'` — another runner already owns it, or it is terminal.
 *    Re-run safety (F1): because `done` is committed atomically with the persist,
 *    a replay of a succeeded job claims nothing and never re-runs STT/LLM nor
 *    duplicates tags.
 *  - `kind='analyze'` — this is the AUDIO-FIRST pipeline. A `reanalyze` job must
 *    never be claimed here (it would re-transcribe recording audio FR-002 already
 *    deleted, overwrite the user's edited transcript, and clear user-edited tags
 *    via the delete-ALL tag write). Mirrors `reanalyzeJob`'s kind-scoped claim, so
 *    the guard lives in the claim itself rather than resting on every caller
 *    dispatching correctly — `jobs.replay` reaches this function directly.
 *    No migration: `kind` is `NOT NULL DEFAULT 'analyze'` and `drizzle/0002`
 *    backfilled every pre-existing row.
 */
export async function processJob(
	jobId: string,
	deps: WorkerDeps,
): Promise<void> {
	const now = deps.now ?? (() => new Date());

	// Atomic claim + attempt-count increment, scoped to `kind='analyze'` so this
	// worker can NEVER claim a re-analyze job. Shared with `reanalyzeJob` — see
	// `claim.ts` for why the compare-and-swap lives in one place.
	const job = await claimJob(deps.db, jobId, {
		kind: "analyze",
		toStatus: "transcribing",
	});
	if (!job) return; // lost the claim race, not pending, or not an analyze job — no-op.

	logJobEvent({
		event: "job.claimed",
		jobId,
		conversationId: job.conversationId,
		status: "transcribing",
		attemptCount: job.attemptCount,
	});

	try {
		// --- transcribing ---
		const [conv] = await deps.db
			.select({
				recordingSid: conversations.recordingSid,
				categoryOverridden: conversations.categoryOverridden,
				projectOverridden: conversations.projectOverridden,
			})
			.from(conversations)
			.where(eq(conversations.id, job.conversationId));
		const recordingSid = conv?.recordingSid ?? null;

		const audio = await resolveAudioSource(deps, recordingSid);
		let transcript: TranscriptResult;
		try {
			transcript = await deps.stt.transcribe({ audio, language: "pl-PL" });
		} finally {
			// F1: tear down the recording pull on EVERY exit (success OR provider
			// error) so a provider that errors before draining the body can't leave
			// the Twilio pull stalled on backpressure. No-op for the mock url source.
			if (audio.kind === "stream") audio.cleanup?.();
		}

		// --- analyzing --- (separate checkpoint so a crash here is re-queued by the boot sweep)
		await deps.db
			.update(processingJobs)
			.set({ status: "analyzing" })
			.where(eq(processingJobs.id, jobId));
		logJobEvent({
			event: "job.analyzing",
			jobId,
			conversationId: job.conversationId,
			status: "analyzing",
		});

		// --- transcript backstop (never lose a real note) ---
		// Persist the transcript NOW, before analyze()/classify(), so a ProviderError
		// (a refusal, an invalid_response, an exhausted transport retry) dead-letters
		// to `failed` WITH the transcript present — not lost in RAM. Idempotent with
		// the done-txn write below (identical columns + values; Open Q#7 resolved).
		// The columns are nullable and the UI already renders transcript-present /
		// analysis-NULL as a terminal failed note (deriveStatus keys terminality on
		// the `failed` job status here, not on analysis presence).
		await deps.db
			.update(conversations)
			.set({
				transcriptSegments: transcript.segments,
				transcriptLanguage: transcript.language,
				durationMs: transcript.durationMs,
			})
			.where(eq(conversations.id, job.conversationId));

		// --- tag vocabulary (phase 5) ---
		// The existing tag names, handed to the model as the namespace to reuse.
		// Read HERE (outside the closing transaction, which must stay narrow) and
		// degrading to an empty list on failure — see `vocabulary.ts` for why a
		// vocabulary read may never be the thing that costs a note.
		const vocabulary = await loadPromptVocabulary(deps.db, {
			userId: job.userId,
			jobId,
			conversationId: job.conversationId,
		});

		const analysis = await deps.analyze({
			transcript: joinTranscript(transcript.segments),
			vocabulary,
		});

		// --- classify (FR-005) ---
		// Runs BEFORE the persist transaction so the LLM round-trip never holds the
		// SQLite writer lock. Override guard (S-06 contract): if the user already
		// owns the classification (EITHER flag set), skip auto-fill entirely — never
		// write an auto pair over a user-chosen one. At S-03 first run both flags are
		// false, so this always runs; the guard is dormant-but-correct until re-analyze.
		// `no_auto_assignment` (constraint exhaustion or no projects to file into) is a
		// `done` outcome with NULL columns — NOT a failure. A `ProviderError` from
		// `classify()` propagates to the catch below for retry/dead-letter by code.
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
			// `projects.category` is plain text (no DB CHECK). The tRPC create path
			// only ever stores valid categories, but the worker degrades gracefully if
			// a malformed row appears (a hand-edited migration or the documented
			// emergency `fly ssh` INSERT): skip THAT row — worst case the user gets
			// `no_auto_assignment` — rather than dead-lettering every job for the user.
			// safeParse, not parse: one bad row must not throw a ZodError into the
			// catch (which would fail-fast as a miscoded `unknown` dead-letter).
			const projectList: Project[] = [];
			for (const p of projectRows) {
				const parsed = categorySchema.safeParse(p.category);
				if (!parsed.success) {
					logJobEvent({
						event: "job.invalid_project_skipped",
						jobId,
						conversationId: job.conversationId,
					});
					continue;
				}
				projectList.push({ id: p.id, name: p.name, category: parsed.data });
			}
			// Short-circuit: no (valid) projects to file into → no auto-assignment,
			// skip the LLM entirely.
			if (projectList.length > 0) {
				const result = await deps.classify({
					transcript: joinTranscript(transcript.segments),
					projects: projectList,
				});
				if (result.status === "classified") {
					autoClassification = result.classification;
				}
			}
		}

		// --- persist + mark done atomically ---
		// A successful analysis is durable BEFORE any recording delete: the
		// transcript/analysis write, the idempotent tag rewrite, and status='done'
		// all land in one transaction.
		await deps.db.transaction(async (tx) => {
			await tx
				.update(conversations)
				.set({
					transcriptSegments: transcript.segments,
					transcriptLanguage: transcript.language,
					durationMs: transcript.durationMs,
					analysis,
					// Auto-classification: written only when classify() returned a valid
					// pair AND the user hasn't overridden it. On no_auto_assignment,
					// short-circuit, or a user override, the columns are left untouched
					// (NULL on first run) — never a half-written category/project pair.
					...(autoClassification
						? {
								category: autoClassification.category,
								projectId: autoClassification.projectId,
							}
						: {}),
				})
				.where(eq(conversations.id, job.conversationId));

			// Idempotent tag write under the `replace-all` policy: clear this
			// conversation's tags, then insert the fresh candidates. Safe to be
			// destructive HERE — this pipeline's only callers are a first run and a
			// replay, neither of which has user-edited tags to protect (the re-analyze
			// path, which does, passes `merge`; the claim's `kind='analyze'` predicate is
			// what keeps a re-analyze job out of this branch). Mechanics — including
			// write-time normalization + dedup — live in the shared reconciler.
			await reconcileTags(tx, {
				userId: job.userId,
				conversationId: job.conversationId,
				candidates: analysis.candidateTags,
				policy: "replace-all",
			});

			await tx
				.update(processingJobs)
				.set({ status: "done" })
				.where(eq(processingJobs.id, jobId));
		});
		logJobEvent({
			event: "job.done",
			jobId,
			conversationId: job.conversationId,
			status: "done",
		});

		// --- post-done best-effort cleanup (FR-002) ---
		// The job is already `done`, so a delete failure is logged, not fatal; the
		// delete sweep retries it. 404-tolerance lives in the provider.
		if (recordingSid) {
			try {
				await deps.telephony.deleteRecording({ recordingSid });
				await deps.db
					.update(conversations)
					.set({ recordingDeletedAt: now() })
					.where(eq(conversations.id, job.conversationId));
				logJobEvent({
					event: "job.recording_deleted",
					jobId,
					conversationId: job.conversationId,
				});
			} catch (err) {
				logJobEvent({
					event: "job.recording_delete_failed",
					jobId,
					conversationId: job.conversationId,
					error: errorMessage(err),
				});
			}
		}
	} catch (err) {
		// Switch on the discriminator: retryable + under the cap → re-enqueue with
		// backoff (re-enqueue, NOT an in-process sleep — that dies with the process
		// and holds RAM); else fail fast to the dead-letter.
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
				event: "job.retry",
				jobId,
				conversationId: job.conversationId,
				status: "pending",
				attemptCount: job.attemptCount,
				errorCode: errorCode(err),
			});
		} else {
			// A graceful model decline (`refusal`) is non-retryable and lands here like
			// any other terminal error — NO separate routing branch (a `done`+NULL job
			// would mis-render as perpetual "Przetwarzanie…"). The only delta is an
			// additive, countable log line so a decline is distinguishable from a
			// malformed `invalid_response` in `fly logs`. The transcript backstop above
			// guarantees this `failed` job still shows its transcript.
			if (err instanceof ProviderError && err.code === "refusal") {
				logJobEvent({
					event: "job.refused",
					jobId,
					conversationId: job.conversationId,
					attemptCount: job.attemptCount,
					errorCode: "refusal",
				});
			}
			await deps.db
				.update(processingJobs)
				.set({
					status: "failed",
					lastError: errorMessage(err),
					lastErrorCode: errorCode(err),
				})
				.where(eq(processingJobs.id, jobId));
			logJobEvent({
				event: "job.failed",
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
 * Fire-and-forget entry used by the recording-status webhook fast-path. Funnels
 * through the same atomic claim as the poller, so the two can never both process
 * one job. The `.catch` is the last-resort net: `processJob` handles its own
 * pipeline errors, so this only fires if the claim/select SQL itself throws —
 * mark the job failed rather than leak an unhandled rejection.
 */
export function kickoff(jobId: string, deps: WorkerDeps): void {
	void processJob(jobId, deps).catch(async (err) => {
		logJobEvent({
			event: "job.kickoff_crashed",
			jobId,
			error: errorMessage(err),
		});
		try {
			// Only dead-letter a row still owned by THIS attempt (mid-flight). If
			// processJob's own catch already re-enqueued it to 'pending' (recoverable)
			// or it reached 'done', leave it untouched — this last-resort write must
			// not clobber a legitimately-pending/succeeded job. Matches the guard
			// discipline of the claim/retry/fail/replay writes (F1: previously the only
			// unguarded status mutation). A stuck mid-flight row is otherwise recovered
			// by runBootSweep, so failing it here is strictly an improvement, never a
			// regression.
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
						inArray(processingJobs.status, ["transcribing", "analyzing"]),
					),
				);
		} catch {
			// swallow — nothing more we can safely do off the request path.
		}
	});
}
