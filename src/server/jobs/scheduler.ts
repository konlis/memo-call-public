/**
 * Recovery sweep + poller (Phase 4 of `call-to-analysis-pipeline`).
 *
 * Survives crash/deploy by re-queueing interrupted jobs (`runBootSweep`), drains
 * due `pending` jobs (`startPoller` → `pollOnce`), retries the best-effort
 * FR-002 recording delete (`runDeleteSweep`), recovers calls whose recording
 * notification never arrived (`runReconcileSweep`,
 * `telephony-capture-reconciliation`), and resolves who each new call was with
 * (`runCounterpartySweep` in `counterparty.ts`, FR-025 — run on the same
 * cadence, right after reconciliation). All sweeps are idempotent and safe to
 * call repeatedly. Started once at server boot from `src/instrumentation.ts`.
 */
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	notInArray,
	or,
} from "drizzle-orm";

import { ProviderError } from "~/server/_lib/provider-error";
import { safeErrorMessage } from "~/server/_lib/redact";
import {
	conversations,
	processingJobs,
	reconcileTombstones,
} from "~/server/db/schema";
import { logJobEvent } from "~/server/jobs/audit";
import { backfillConversation } from "~/server/jobs/backfill";
import { runCounterpartySweep } from "~/server/jobs/counterparty";
import { JOB_KINDS, resolveJobHandler } from "~/server/jobs/registry";
import type { WorkerDeps } from "~/server/jobs/worker";

/** Default poll cadence — tuned for single-user, low-QPS load (a constant, easy to revisit). */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Run the delete sweep only every Nth poll tick (~30 s at the 5 s cadence). The
 * happy-path recording delete already happens inline in `processJob` right after
 * `done`, so the sweep is purely the *retry* backstop for deletes that failed.
 * Throttling it (F3) keeps a persistently-failing delete (Twilio 5xx / permission)
 * from hammering the API + spamming the log every 5 s. A hard retry cap would need
 * a per-recording attempt column (a migration) — deferred; the cadence throttle is
 * the migration-free MVP fix.
 */
export const DELETE_SWEEP_EVERY_N_TICKS = 6;

/**
 * Run the reconcile sweep every Nth tick — 60 × 5 s ≈ 5 minutes.
 *
 * The number is set by the product tolerance, not by a technical limit: a note
 * that shows up "within minutes" is indistinguishable from one captured live,
 * and the recovery cost is one HTTP request to the provider plus one indexed
 * SELECT. Going faster buys nothing (the grace below already dominates the
 * end-to-end latency) and costs a vendor round-trip inside the poller tick,
 * which delays the next job claim.
 */
export const RECONCILE_SWEEP_EVERY_N_TICKS = 60;

/**
 * The sweep's window ENDS at `now − 10 min`, and this grace is MANDATORY, not
 * cautious tuning.
 *
 * Without it a call that ended seconds ago qualifies, and if the provider
 * reports the recording as resident before the file is actually fetchable, the
 * backfilled job hits a not-yet-ready recording and can dead-letter a
 * conversation the webhook path would have handled without a problem. Note
 * which race this closes: `conv_user_callsid_uq` makes us immune to a LATE
 * webhook, but that is the other direction entirely — nothing in the index
 * protects against an EARLY sweep.
 *
 * ⚠️ WHAT IT DOES NOT COVER, said plainly because the first version of this
 * comment claimed otherwise (impl-review F3). The grace shifts the window's
 * `until`, which the provider applies to the call's START time — Zadarma's
 * statistics `end` parameter against `callstart`. So it bounds "started
 * recently", NOT "ended recently": a call that began 40 minutes ago and hung up
 * thirty seconds ago is inside the window with no grace at all. For a
 * voice-notes product, calls longer than ten minutes are ordinary, so this is a
 * real gap and not a corner case — it is narrower than it looks only because a
 * leg still in progress is unlikely to be reported as having a resident
 * recording. Closing it properly means dropping a row whose
 * `callstart + seconds` falls inside the grace (the mapper already reads
 * `seconds`); that was deferred pending a phase-3 measurement of what
 * `start`/`end` actually filter on. Do NOT restore the words "or is still
 * running" here without that measurement.
 */
export const RECONCILE_GRACE_MS = 10 * 60_000;

/**
 * How far back the sweep looks. 24 h is generous on purpose: the debt ledger is
 * "recordings still resident at the provider", so a wide window costs one
 * response of a few dozen rows and buys recovery across a Machine restart or a
 * deploy that spanned several missed sweeps.
 */
export const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * At most this many per-row lines per sweep; the rest are counted into the run
 * line's `suppressed`. A permanently-failing write is self-sustaining (the row
 * is never created, so it is "missing" again next run), and these lines share
 * Fly's ~7-day window with the auth and job audit trails, which have no other
 * home. The budget is the same control `telephony/ingress-log.ts` applies for
 * the same reason.
 */
export const RECONCILE_LOG_BUDGET = 20;

/**
 * Cap on the `callSid` written to a log line (full-review F10d).
 *
 * Generous against every id shape any provider here produces (Zadarma's is 44
 * chars, Twilio's 34) and tight against a provider — present or future — whose
 * value is not bounded at all.
 */
const MAX_LOGGED_CALL_SID_CHARS = 80;

/** Hard cap on an error message reaching the log — see `logReconcileFailure`. */
const MAX_LOGGED_ERROR_CHARS = 200;

function clock(deps: Pick<WorkerDeps, "now">): Date {
	return (deps.now ?? (() => new Date()))();
}

/**
 * Re-queue jobs interrupted by a crash/deploy: any row stuck mid-flight
 * (`transcribing`/`analyzing`) flips back to `pending`. Safe at boot — no worker
 * is running yet, so this can't race a live claim. Returns the re-queued count
 * (for the boot log line). Run this BEFORE `startPoller`.
 *
 * Also emits a one-shot census of rows carrying a kind no pipeline handles. Such
 * a row can only come from a hand-edited migration or the documented emergency
 * `fly ssh` INSERT (the app writes only the column default or `'reanalyze'`), and
 * `pollOnce` deliberately skips it — so without this line it would be invisible
 * forever. Boot is the right cadence: the row cannot appear without someone
 * touching the DB directly, and a per-tick census would buy nothing for a real
 * per-tick cost.
 */
export async function runBootSweep(
	deps: Pick<WorkerDeps, "db">,
): Promise<number> {
	const reset = await deps.db
		.update(processingJobs)
		.set({ status: "pending" })
		.where(inArray(processingJobs.status, ["transcribing", "analyzing"]))
		.returning({ id: processingJobs.id });

	const undispatchable = await deps.db
		.select({ id: processingJobs.id, kind: processingJobs.kind })
		.from(processingJobs)
		.where(
			and(
				eq(processingJobs.status, "pending"),
				notInArray(processingJobs.kind, JOB_KINDS),
			),
		);
	for (const row of undispatchable) {
		logJobEvent({
			event: "job.unknown_kind_skipped",
			jobId: row.id,
			kind: row.kind,
			status: "pending",
		});
	}

	return reset.length;
}

/**
 * Claim-and-process the oldest due `pending` job, if any. "Due" = `next_retry_at`
 * is null or in the past. The actual claim is the atomic compare-and-swap inside
 * the resolved handler, so a concurrent tick that selected the same row simply
 * loses the claim and no-ops.
 *
 * The `kind IN (…)` predicate is a head-of-line-blocking guard, not a nicety.
 * Both claims are kind-scoped, so a row whose `kind` matches no pipeline is
 * claimable by nobody; without this filter the `limit(1)` oldest-first select
 * would return that same row on every tick forever and NO job would ever be
 * processed again — a silent, total outage. Filtering makes such a row inert
 * instead of poisonous; `runBootSweep` logs its existence so it stays visible.
 */
export async function pollOnce(deps: WorkerDeps): Promise<void> {
	const now = clock(deps);
	const [due] = await deps.db
		.select({ id: processingJobs.id, kind: processingJobs.kind })
		.from(processingJobs)
		.where(
			and(
				eq(processingJobs.status, "pending"),
				inArray(processingJobs.kind, JOB_KINDS),
				or(
					isNull(processingJobs.nextRetryAt),
					lte(processingJobs.nextRetryAt, now),
				),
			),
		)
		.orderBy(asc(processingJobs.createdAt))
		.limit(1);

	if (!due) return;
	// Dispatch by kind through the registry: a `reanalyze` job (poller-drained or
	// boot-recovered) MUST run the transcript-sourced path, not the audio-first STT
	// path — `processJob` would re-transcribe and clobber the edited transcript. The
	// boot sweep already resets `analyzing → pending` for both kinds; this dispatch
	// completes the recovery.
	await resolveJobHandler(due.kind).run(due.id, deps);
}

/**
 * Best-effort FR-002 cleanup: for conversations whose job reached `done` but whose
 * recording is still resident (`recording_sid IS NOT NULL AND recording_deleted_at
 * IS NULL`), retry the provider delete and stamp `recording_deleted_at` on success.
 * 404-tolerance lives in the provider; a failure here is logged and retried next tick.
 */
export async function runDeleteSweep(deps: WorkerDeps): Promise<void> {
	const now = clock(deps);
	const rows = await deps.db
		.select({
			conversationId: conversations.id,
			recordingSid: conversations.recordingSid,
		})
		.from(conversations)
		.innerJoin(
			processingJobs,
			eq(processingJobs.conversationId, conversations.id),
		)
		.where(
			and(
				// Scoped like every other user-owned query (the multi-user-ready
				// invariant in CLAUDE.md). Constant today, but the constant is PASSED,
				// so the day it stops being one this query does not quietly sweep
				// another user's recordings.
				eq(conversations.userId, deps.userId),
				eq(processingJobs.status, "done"),
				isNotNull(conversations.recordingSid),
				isNull(conversations.recordingDeletedAt),
			),
		);

	for (const row of rows) {
		if (!row.recordingSid) continue;
		try {
			await deps.telephony.deleteRecording({ recordingSid: row.recordingSid });
			await deps.db
				.update(conversations)
				.set({ recordingDeletedAt: now })
				.where(eq(conversations.id, row.conversationId));
		} catch (err) {
			console.error(
				JSON.stringify({
					event: "job.delete_sweep_failed",
					conversationId: row.conversationId,
					error: safeErrorMessage(err),
				}),
			);
		}
	}
}

/**
 * Capture reconciliation (`telephony-capture-reconciliation`).
 *
 * Zadarma sends `NOTIFY_RECORD` once and never retries, so one dropped
 * notification used to mean one permanently lost note with NO signal anywhere —
 * found on 2026-09-08 only because the operator remembered making the call.
 *
 * This does not try to make someone else's webhook reliable, and it does not
 * model a "call" as an entity. It leans on a side property of FR-002: a
 * recording is deleted at the provider ONLY after its job succeeds, so the set
 * of recordings still resident there IS the set we have not turned into notes.
 * Ask for that set, drop the ones we already have a `conversations` row for,
 * and backfill the rest through the same write path the webhook uses.
 *
 * THE DETECTOR IS THE MISSING ROW, never residency alone. A conversation whose
 * job dead-lettered keeps its recording resident indefinitely (that is the known
 * FR-002 debt, out of scope here); a condition written on residency would
 * re-enqueue it every five minutes, forever.
 *
 * Best-effort exactly like `runDeleteSweep`: a provider failure is logged and
 * swallowed, a single bad row does not abandon the rest of the batch, and
 * nothing propagates into the tick.
 */
export async function runReconcileSweep(deps: WorkerDeps): Promise<void> {
	// No capability → no reconciliation, and that is an honest state rather than
	// a failure (mock has no vendor to ask; Twilio is being wound down). It is
	// deliberately SILENT: emitting a run line here would make an inert sweep
	// look like a working one in `fly logs`, which is the precise confusion the
	// logging below exists to prevent.
	if (!deps.telephony.listRecordingsAwaitingCapture) return;

	// ONE try around the whole run, so EVERY way of failing produces the same
	// named line. The narrower version guarded only the provider call, which left
	// a database failure escaping into the tick as a generic `job.poll_tick_failed`
	// with no mention of reconciliation and no run line — a silence in the one
	// subsystem whose entire purpose is to abolish silences (impl-review F7). The
	// per-row catch inside stays: one bad row must not abandon the batch.
	try {
		const now = clock(deps);
		const until = new Date(now.getTime() - RECONCILE_GRACE_MS);
		const since = new Date(until.getTime() - RECONCILE_WINDOW_MS);

		const pending = await deps.telephony.listRecordingsAwaitingCapture({
			since,
			until,
		});

		// The same defensive guard the webhook path applies before it writes
		// (`webhooks.ts`): a blank `call_sid` is NOT NULL as far as the partial
		// unique index is concerned, so a row carrying one would collapse every
		// such call onto a single conversation. Today `PBX_CALL_ID_SHAPE` in the
		// Zadarma mapper makes this unreachable — but the `TelephonyProvider`
		// contract promises nothing about it, and this is the write path, not the
		// mapper (impl-review F6).
		const usable = pending.filter((r) => r.callSid && r.recordingSid);
		const malformed = pending.length - usable.length;

		let backfilled = 0;
		let missing = 0;
		let logged = 0;
		let suppressed = 0;

		if (usable.length > 0) {
			const callSids = usable.map((r) => r.callSid);
			// TWO batch queries, never one per call. Both answer the same question —
			// "do we already know about this call?" — from the two places that can
			// know it.
			const known = await deps.db
				.select({ callSid: conversations.callSid })
				.from(conversations)
				.where(
					and(
						eq(conversations.userId, deps.userId),
						inArray(conversations.callSid, callSids),
					),
				);
			// A DELETED conversation is indistinguishable from a never-captured one
			// by the missing-row detector alone — it is a resident recording with no
			// row, which is the exact shape this sweep exists to backfill. Without
			// this second lookup, one failed provider-side recording delete means the
			// user's deleted note reappears within five minutes and its audio is sent
			// to STT + LLM a second time (impl-review F1). The tombstone outlives the
			// conversation precisely so this question still has an answer.
			// These two reads are a cheap PRE-FILTER, not the guarantee — and the
			// distinction is measured, not assumed (full-review F10a). The
			// authoritative check lives inside `backfillConversation`'s own
			// transaction, which re-reads this table before it inserts anything.
			//
			// The order still matters, just less than it looks. `known` first,
			// `buried` second is safe in every interleaving with a concurrent delete
			// (that delete commits both halves in ONE transaction, so if `known`
			// missed the row the LATER `buried` read must see the tombstone).
			// Swapping them opens a window — `buried` read before the commit, `known`
			// after — where neither query knows the call.
			//
			// A cross mutation matrix says exactly what each defence carries:
			// swapping the order alone still cannot resurrect (the write-path guard
			// catches it), removing the write-path guard alone still cannot
			// (this order catches it), and only removing BOTH resurrects a deleted
			// note. They are redundant on purpose; do not delete either on the
			// grounds that the other exists. `scheduler.test.ts`'s
			// "known-before-buried" test drives that interleaving end to end.
			const buried = await deps.db
				.select({ callSid: reconcileTombstones.callSid })
				.from(reconcileTombstones)
				.where(
					and(
						eq(reconcileTombstones.userId, deps.userId),
						inArray(reconcileTombstones.callSid, callSids),
					),
				);
			const seen = new Set([
				...known.map((r) => r.callSid),
				...buried.map((r) => r.callSid),
			]);

			for (const row of usable) {
				if (seen.has(row.callSid)) continue;
				missing += 1;
				try {
					const jobId = await backfillConversation(deps.db, {
						userId: deps.userId,
						callSid: row.callSid,
						recordingSid: row.recordingSid,
						startedAt: row.startedAt,
						endedAt: row.endedAt,
						durationMs: row.durationMs,
					});
					// `null` = the webhook landed between our SELECT and this INSERT and
					// `conv_user_callsid_uq` absorbed us. Not an error — the note exists.
					if (jobId === null) continue;
					backfilled += 1;
					// The ONE line allowed to name a call: `call_sid` is a provider token
					// that leads to no counterparty, and without it a recovered
					// conversation cannot be traced back to the sweep that recovered it.
					// NO kickoff — we are inside a poller tick, so `pollOnce` claims this
					// job on the next one (≤5 s). Buying those seconds would mean
					// resolving a worker through the registry on a path that has no
					// business knowing which handlers exist.
					if (logged < RECONCILE_LOG_BUDGET) {
						logged += 1;
						console.error(
							JSON.stringify({
								ts: Date.now(),
								event: "telephony.reconcile.backfilled",
								// Capped (full-review F10d). Under Zadarma the mapper guarantees
								// `^(?:in|out)_[0-9a-f]{40}$`, but this sweep is written against the
								// vendor-NEUTRAL `TelephonyProvider` contract, which promises
								// nothing about the value — the blank-`callSid` guard above says so
								// itself. `JSON.stringify` escapes newlines, so this is not a
								// line-injection primitive, only an unbounded-length one; the
								// neighbours that already treat this value as untrusted are
								// `describeIdShape` in `zadarma.ts` and `logReconcileFailure` below.
								callSid: row.callSid.slice(0, MAX_LOGGED_CALL_SID_CHARS),
								jobId,
							}),
						);
					} else {
						suppressed += 1;
					}
				} catch (err) {
					if (logged < RECONCILE_LOG_BUDGET) {
						logged += 1;
						logReconcileFailure(err, row.callSid);
					} else {
						suppressed += 1;
					}
				}
			}
		}

		// Emitted on EVERY run, including the empty one. A sweep that is not
		// running and a sweep that runs and finds nothing are the same silence
		// otherwise — and trading one silent gap for another is the realistic way
		// this change fails. Counters only: the provider's response carries the
		// other party's number, and none of it reaches a log line.
		//
		// SCOPE OF THE BUDGET (full-review F9): it covers the lines THIS function
		// emits — `.backfilled` and `.failed`. It does NOT cover `job.enqueued`,
		// which `backfillConversation` writes from the shared write path, so a run
		// that backfills many calls emits one unbudgeted line per call on top of
		// the 20 budgeted ones. That is tolerable only because the successful case
		// is NOT self-sustaining: a backfill that works creates the row, so the
		// same call is not "missing" on the next run. The failure case, which IS
		// self-sustaining, is the one the budget below actually guards.
		//
		// `suppressed` is not cosmetic. A write that fails PERMANENTLY is
		// self-sustaining here: the row is never created, so it is "missing" again
		// on the next run — unbudgeted, that is up to a thousand lines every five
		// minutes, enough to push the auth (`auth/audit.ts`) and job
		// (`jobs/audit.ts`) trails out of Fly's ~7-day window, which is their ONLY
		// home (there is no DB audit table). Same reasoning as the budget in
		// `telephony/ingress-log.ts` (impl-review F4).
		console.error(
			JSON.stringify({
				ts: Date.now(),
				event: "telephony.reconcile.sweep",
				scanned: pending.length,
				malformed,
				missing,
				backfilled,
				suppressed,
			}),
		);
	} catch (err) {
		logReconcileFailure(err);
	}
}

function logReconcileFailure(err: unknown, callSid?: string): void {
	console.error(
		JSON.stringify({
			ts: Date.now(),
			event: "telephony.reconcile.failed",
			...(callSid ? { callSid } : {}),
			...(err instanceof ProviderError ? { errorCode: err.code } : {}),
			// Redacted AND length-capped before it reaches the log. A `ProviderError`
			// from `assertZadarmaOk` is already redacted + capped on the vendor side,
			// but a libsql or TypeError message is not — and a `DrizzleQueryError`
			// prints the failed statement's bound values — and this stream is a
			// shared, finite resource (see the `suppressed` note above).
			error: safeErrorMessage(err, MAX_LOGGED_ERROR_CHARS),
		}),
	);
}

/**
 * Start the poll loop. Each tick drains one due job; the delete sweep runs on a
 * slower cadence (every `DELETE_SWEEP_EVERY_N_TICKS` ticks — see F3) and the
 * reconcile sweep on a slower one still (`RECONCILE_SWEEP_EVERY_N_TICKS`). A tick never
 * throws (errors are swallowed + logged) so a transient DB hiccup can't kill the
 * interval. The interval is `unref`'d so it never keeps the process alive on its
 * own. Returns a stop function (used by tests).
 */
export function startPoller(
	deps: WorkerDeps,
	intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): () => void {
	let tickCount = 0;
	const tick = async () => {
		try {
			await pollOnce(deps);
			// Delete sweep is best-effort retry cleanup, not latency-sensitive — run it
			// on the throttled cadence so a stuck recording doesn't hammer Twilio + the
			// log every tick. The inline post-`done` delete in processJob covers the
			// happy path immediately.
			tickCount += 1;
			if (tickCount % DELETE_SWEEP_EVERY_N_TICKS === 0) {
				await runDeleteSweep(deps);
			}
			// Capture reconciliation on its own, much slower cadence — it costs a
			// vendor round-trip, and its end-to-end latency is dominated by
			// `RECONCILE_GRACE_MS` anyway.
			if (tickCount % RECONCILE_SWEEP_EVERY_N_TICKS === 0) {
				await runReconcileSweep(deps);
				// AFTER reconciliation, in the same tick, so a conversation the
				// reconciler just backfilled gets its first chance at a number in
				// this run rather than five minutes later. Own try inside; a
				// failure there cannot reach this catch (FR-025).
				await runCounterpartySweep(deps);
			}
		} catch (err) {
			console.error(
				JSON.stringify({
					event: "job.poll_tick_failed",
					error: safeErrorMessage(err),
				}),
			);
		}
	};

	const handle = setInterval(() => void tick(), intervalMs);
	// Don't keep the event loop alive solely for the poller.
	if (typeof handle.unref === "function") handle.unref();
	return () => clearInterval(handle);
}
