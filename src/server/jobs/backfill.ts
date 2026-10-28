/**
 * The ONE write path that turns "a recording exists at the provider" into the
 * `conversations` + `processing_jobs` pair the pipeline runs on
 * (`telephony-capture-reconciliation` phase 2).
 *
 * Two callers reach it and they arrive by very different routes: the webhook
 * (`telephony/webhooks.ts`, the provider pushes) and the reconcile sweep
 * (`jobs/scheduler.ts`, we pull). This module exists because they MUST NOT each
 * own a copy.
 *
 * WHY THAT IS A SECURITY PROPERTY, not tidiness: the idempotency here rests on
 * the partial-unique index `conv_user_callsid_uq` on `(user_id, call_sid)`, and
 * under Zadarma that index is the only thing standing between us and webhook
 * replay — that vendor signs a bare concatenation of body fields, with no URL,
 * no timestamp and no nonce, so a captured (body, signature) pair stays valid
 * forever. A second copy of this transaction is a second chance for someone to
 * "simplify" the conflict clause in one place and not the other, and the
 * failure mode is silent: a duplicate conversation, or a second job re-running
 * STT + LLM over audio already processed.
 */
import { and, eq } from "drizzle-orm";
import type { db as Db } from "~/server/db";
import {
	conversations,
	processingJobs,
	reconcileTombstones,
} from "~/server/db/schema";
import { logJobEvent } from "~/server/jobs/audit";

/**
 * Only the transaction entrypoint is needed. The structural narrow is the same
 * one `RecordingStatusDeps` uses, and it is what lets the webhook handler tests
 * stay on a stub instead of a live libsql client.
 */
export type BackfillDb = Pick<typeof Db, "transaction">;

/**
 * Everything the pair of rows needs, and deliberately nothing more.
 *
 * NO PHONE-NUMBER FIELD, and that absence is load-bearing — it mirrors
 * `PendingRecording` in `telephony/types.ts`, where the same reasoning is
 * written out in full. The webhook's `RecordingEvent` DOES carry `from`/`to`;
 * this type is where they stop, so a future caller cannot hand a number to the
 * write path even by accident.
 *
 * STILL TRUE AFTER FR-025 (2026-10-19), and now by design rather than by
 * default: `conversations` carries the other party's number, but it reaches
 * the row by a SEPARATE path — `jobs/counterparty.ts` UPDATEs a row that
 * already exists. This INSERT path only marks the row as waiting for one
 * (`counterpartyState: "pending"`, a constant set below, not a caller's
 * field). Two writes, two guards; neither caller of this function can smuggle
 * a number in, because there is nowhere to put it.
 *
 * The three timing fields are optional because a provider may not report them
 * (Zadarma's statistics path does not — see `zadarma-statistics.ts`), and their
 * columns are nullable already.
 */
export type BackfillInput = {
	userId: string;
	callSid: string;
	recordingSid: string;
	startedAt?: Date;
	endedAt?: Date;
	durationMs?: number;
};

/**
 * Durably create the conversation + its `pending` analyze job, idempotently.
 *
 * Returns the new `jobId`, or `null` when the conversation already existed —
 * the ONLY signal a caller gets, and all either of them needs: the webhook logs
 * `enqueued` vs `duplicate` off it and kicks the worker off only on a new row;
 * the sweep counts it. Both directions of the capture race collapse into that
 * `null`: a webhook arriving after the sweep backfilled the same call, and a
 * sweep running over a call the webhook already captured.
 *
 * One transaction, so a crash between the two INSERTs cannot leave a
 * conversation with no job — invisible in the panel and never retried, which is
 * the exact silent loss this change exists to abolish.
 */
export async function backfillConversation(
	db: BackfillDb,
	input: BackfillInput,
): Promise<string | null> {
	return db.transaction(async (tx) => {
		// FIRST, before anything is created: has the user destroyed this call?
		//
		// `reconcile_tombstones` is stated in `schema.ts` as an UNQUALIFIED
		// invariant — "a deleted call is never captured again" — and until the full
		// review (F1) it was enforced in exactly one caller, the sweep. That left
		// the push path unguarded, and deletion is precisely what re-opens it:
		// removing the row also removes what `conv_user_callsid_uq` was absorbing,
		// and this file's own header explains that under Zadarma that index is the
		// ONLY replay defense (the vendor signs no URL, no timestamp, no nonce, so a
		// captured (body, signature) pair stays valid forever). It does not take an
		// attacker either — a genuinely late notification arriving after the user
		// deleted the note does the same thing.
		//
		// The check belongs HERE, not in each caller, for the reason
		// `tombstoneCallSids` states below: "what may be captured" and "what may
		// never be captured again" are one decision. The sweep keeps its batch
		// lookup as a cheap pre-filter; this is the authoritative one.
		//
		// Deliberately NO log line: this runs on an unauthenticated path, and a
		// replay could then emit one line per request — the eviction primitive
		// against Fly's ~7-day window that `ingress-log.ts` and
		// `RECONCILE_LOG_BUDGET` both exist to prevent. The caller's existing
		// BUDGETED ingress line (`outcome:"duplicate"`, from the `null` return)
		// already records that something was refused.
		const buried = await tx
			.select({ callSid: reconcileTombstones.callSid })
			.from(reconcileTombstones)
			.where(
				and(
					eq(reconcileTombstones.userId, input.userId),
					eq(reconcileTombstones.callSid, input.callSid),
				),
			)
			.limit(1);
		if (buried.length > 0) return null;

		const conversationId = crypto.randomUUID();
		const inserted = await tx
			.insert(conversations)
			.values({
				id: conversationId,
				userId: input.userId,
				callSid: input.callSid,
				recordingSid: input.recordingSid,
				startedAt: input.startedAt,
				endedAt: input.endedAt,
				durationMs: input.durationMs,
				// FR-025: every conversation captured from here on WAITS for its
				// counterparty; the resolver sweep fills it in (or expires it to
				// `unavailable` after 24 h). A CONSTANT, not an input field — see
				// `BackfillInput`. Rows from before FR-025 keep `NULL` and are never
				// resolved (owner decision #4, no backfill).
				counterpartyState: "pending",
			})
			// Idempotency for a retried/replayed webhook AND for the sweep meeting a
			// call the webhook already captured. Target-LESS `ON CONFLICT DO NOTHING`
			// on purpose: drizzle's `onConflictDoNothing({ target, where })` emits the
			// partial-index predicate in the WRONG position (`do nothing where …`
			// instead of `on conflict (…) where … do nothing`), which libsql rejects as
			// `SQLITE_ERROR: near "where"` (verified against a real DB; the stub-db unit
			// tests could not catch it). A bare `ON CONFLICT DO NOTHING` catches ANY
			// uniqueness conflict — here only the PK (a random UUID, never collides) and
			// the `conv_user_callsid_uq` partial index on (user_id, call_sid) — so it
			// cleanly absorbs the duplicate. FK / NOT NULL / CHECK violations still
			// throw (DO NOTHING only suppresses uniqueness), so this is not a silent
			// catch-all.
			.onConflictDoNothing()
			.returning({ id: conversations.id });

		// Conflict → the conversation already exists → create NO second job. Only
		// the new-conversation path enqueues work.
		if (inserted.length === 0) return null;

		const jobId = crypto.randomUUID();
		await tx.insert(processingJobs).values({
			id: jobId,
			userId: input.userId,
			conversationId,
			status: "pending",
		});
		logJobEvent({
			event: "job.enqueued",
			jobId,
			conversationId,
			status: "pending",
		});
		return jobId;
	});
}

/**
 * Record that these calls must NEVER be captured again — the inverse of
 * `backfillConversation`, and the reason `reconcile_tombstones` exists (see that
 * table's comment in `schema.ts` for the full argument).
 *
 * Lives in this file on purpose: "what may be captured" and "what may never be
 * captured again" are one decision, and splitting them across modules is how a
 * future caller ends up honouring only half of it.
 *
 * CALL IT INSIDE THE SAME TRANSACTION THAT DELETES THE CONVERSATION. Atomicity
 * is the whole guarantee — a deleted row without its tombstone is precisely the
 * state that makes the sweep resurrect a note the user destroyed, and a
 * tombstone without the delete is harmless but pointless. Idempotent, so
 * deleting a call, letting it be re-captured by a webhook, and deleting it again
 * is a no-op on the second pass.
 */
export async function tombstoneCallSids(
	db: Pick<typeof Db, "insert">,
	input: { userId: string; callSids: (string | null)[] },
): Promise<void> {
	// A conversation may legitimately carry a NULL `call_sid` (the column is
	// nullable); there is nothing to bury for one, and NOT NULL would throw.
	const values = input.callSids
		.filter((sid): sid is string => typeof sid === "string" && sid.length > 0)
		.map((callSid) => ({
			id: crypto.randomUUID(),
			userId: input.userId,
			callSid,
		}));
	if (values.length === 0) return;
	await db.insert(reconcileTombstones).values(values).onConflictDoNothing();
}
