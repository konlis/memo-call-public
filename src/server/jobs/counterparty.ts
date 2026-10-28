/**
 * The counterparty sweep (FR-025, `caller-identity-in-archive` phase 3) — the
 * ONE path that writes the other party's number into `conversations`.
 *
 * WHAT IT DOES, in the order it does it, every ~5 minutes right after the
 * reconcile sweep (same poller tick, so a conversation the reconciler just
 * backfilled gets its first chance in the same run):
 *
 *   1. EXPIRE. Every `pending` conversation older than 24 h becomes
 *      `unavailable`. The vendor never produced a statistics row for it in
 *      time; "still unknown" is not a state a note may sit in forever.
 *   2. SELECT the `pending` ones that remain. None → stop, WITHOUT calling the
 *      provider: a quiet instance costs no vendor request.
 *   3. ASK the provider for `[now − 48 h, now]` (`resolveCounterparties`) and,
 *      for each resolution that names a still-`pending` conversation, write
 *      exactly one of:
 *        - `known`   — number (canonicalized) + optional presentation hint;
 *        - `withheld`— the vendor's row carried no usable number (CLIR);
 *        - `unavailable` + `selfRefused` — the candidate was the user's OWN
 *          GSM (`USER_FORWARD_NUMBER`). That is pre-mortem #1 turned into a
 *          COUNTER instead of a guess: the leg rule was measured
 *          in a live spike, but if it is ever wrong the symptom is a non-zero
 *          `selfRefused` in `fly logs`, not the owner's number stored on every
 *          outbound call.
 *      A `pending` conversation with NO resolution in the window stays
 *      `pending` and is counted as `unmatched`; the next sweep tries again.
 *
 * WHY THE WRITE IS `UPDATE … WHERE counterparty_state = 'pending'`, and why
 * that predicate is the whole design rather than a detail:
 *
 *   - It is idempotent: a second sweep over the same window changes no row.
 *   - It can never touch a row captured before FR-025: those have `NULL`,
 *     and `NULL = 'pending'` is never true. Owner decision #4 (no backfill,
 *     ever) is therefore enforced by SQL, not by an `if` someone can remove.
 *   - It cannot clobber a terminal state — `known` is final once written.
 *   - It does not wake the FTS triggers (`drizzle/0005`), which fire only on
 *     `transcript_segments` / `analysis`, so a number is never indexed for
 *     search and the search results before and after are identical.
 *
 * The INSERT path (`backfill.ts`) sets `'pending'` as a constant and carries
 * no number; `BackfillInput` and `PendingRecording` have no field for one.
 * `counterparty-write-path.test.ts` scans `src/server` and fails if the
 * column names appear in any module but this one, the schema, and the read
 * router.
 *
 * CANONICAL FORM is decided HERE, once, because the join to `contacts.e164`
 * only works byte-for-byte: a Polish number goes through `normalizePolishE164`
 * (the same function the contact book writes with), anything else is stored
 * as `+` plus digits. The mapper hands over a shape-validated raw string and
 * nothing more.
 *
 * LOGGING: counters only, one `telephony.counterparty.sweep` line per run,
 * never a line per conversation — the response carries phone numbers and
 * names, and a log line is not one of the places either may live. A failure
 * is one `telephony.counterparty.failed` line through `safeErrorMessage`,
 * which also cuts a `DrizzleQueryError`'s `params:` tail (the bound values of
 * the failed UPDATE — i.e. the number). Best-effort like every sweep: nothing
 * propagates into the poller tick.
 */
import { and, eq, lt } from "drizzle-orm";

import { env } from "~/env";
import { ProviderError } from "~/server/_lib/provider-error";
import { safeErrorMessage } from "~/server/_lib/redact";
import { conversations } from "~/server/db/schema";
import type { WorkerDeps } from "~/server/jobs/worker";
import { normalizePolishE164 } from "~/server/telephony/phone";

/**
 * How far back the provider is asked. 48 h, deliberately wider than the
 * reconciler's 24 h: a conversation the reconcile sweep backfilled may carry a
 * `createdAt` up to ~24 h later than the call it records, and the statistics
 * window filters on the CALL's start, not on our row's. No grace at the near
 * end — a row that is not there yet simply leaves the conversation `pending`.
 *
 * ⚠️ CEILING: the provider answers ONE page (`STATISTICS_PAGE_LIMIT`, 1000
 * rows) and throws on a full one rather than report a partial ledger. One
 * conversation is 2–3 statistics rows, so 48 h holds ~170+ conversations a day
 * before every sweep fails (`telephony.counterparty.failed` every 5 min) and
 * every `pending` row expires to `unavailable`. Loud, and far above one user's
 * volume — but the window is twice the reconciler's under the same cap, so
 * this path hits it first (full-plan impl-review F7). Paginate before a
 * high-volume instance, do not widen the window.
 */
export const COUNTERPARTY_WINDOW_MS = 48 * 60 * 60_000;

/**
 * How long a conversation may stay `pending` before it is declared
 * `unavailable`. Measured against the row's `createdAt`, so a backfilled
 * conversation gets its full 24 h from when WE learned of it.
 */
export const COUNTERPARTY_PENDING_TTL_MS = 24 * 60 * 60_000;

/** Hard cap on an error message reaching the log (as in `scheduler.ts`). */
const MAX_LOGGED_ERROR_CHARS = 200;

/** The subset of `WorkerDeps` this sweep needs — nothing from STT or LLM. */
export type CounterpartySweepDeps = Pick<
	WorkerDeps,
	"db" | "telephony" | "userId" | "now"
>;

export type CounterpartySweepOptions = {
	/**
	 * The user's own GSM, as `placeCall` dials it. A `known` candidate equal
	 * to it (after canonicalization) is REFUSED. Defaults to
	 * `USER_FORWARD_NUMBER`; absent → the self-check is skipped, never an
	 * error. Injectable so the refusal is testable without touching the
	 * process environment (`~/env` parses once at import).
	 */
	selfNumber?: string;
};

function clock(deps: Pick<WorkerDeps, "now">): Date {
	return (deps.now ?? (() => new Date()))();
}

/**
 * One canonical spelling for a number the provider reported. Polish numbers
 * take the contact book's exact form; anything else is `+` + digits. `null`
 * only when there is not a single digit — unreachable for a mapper-validated
 * `rawNumber`, reachable for a malformed `selfNumber`, where it simply
 * disables the self-check.
 */
export function canonicalCounterpartyNumber(raw: string): string | null {
	const polish = normalizePolishE164(raw);
	if (polish !== null) return polish;
	const digits = raw.replace(/\D/g, "");
	return digits.length === 0 ? null : `+${digits}`;
}

/**
 * Run one counterparty sweep. Never throws; see the module header for what
 * one run does and in which order.
 */
export async function runCounterpartySweep(
	deps: CounterpartySweepDeps,
	opts: CounterpartySweepOptions = { selfNumber: env.USER_FORWARD_NUMBER },
): Promise<void> {
	try {
		const now = clock(deps);

		// Step 1 — expire, ALWAYS, even for a provider that cannot resolve
		// anything (mock, Twilio): their conversations must still leave `pending`.
		const expiredRows = await deps.db
			.update(conversations)
			.set({ counterpartyState: "unavailable" })
			.where(
				and(
					eq(conversations.userId, deps.userId),
					eq(conversations.counterpartyState, "pending"),
					lt(
						conversations.createdAt,
						new Date(now.getTime() - COUNTERPARTY_PENDING_TTL_MS),
					),
				),
			)
			.returning({ id: conversations.id });
		const expired = expiredRows.length;

		// Step 2 — what is still waiting for a number?
		const pendingRows = await deps.db
			.select({ callSid: conversations.callSid })
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, deps.userId),
					eq(conversations.counterpartyState, "pending"),
				),
			);
		const pendingSids = new Set(
			pendingRows
				.map((r) => r.callSid)
				.filter((sid): sid is string => typeof sid === "string" && sid !== ""),
		);
		const pending = pendingSids.size;

		// No capability → expiry is all this provider gets. Silent unless the
		// expiry actually changed something: a run line every five minutes
		// saying "resolved 0" would make an inert sweep look like a working one
		// in `fly logs` (the same reasoning as `runReconcileSweep`'s silence).
		if (!deps.telephony.resolveCounterparties) {
			if (expired > 0) {
				logRun({
					pending,
					resolved: 0,
					withheld: 0,
					expired,
					selfRefused: 0,
					selfInbound: 0,
					unparsed: 0,
					unmatched: pending,
				});
			}
			return;
		}

		if (pending === 0) {
			// Nothing to ask about — and so NO vendor request. The line still
			// goes out: a sweep that ran and had nothing to do must be
			// distinguishable from one that did not run.
			logRun({
				pending: 0,
				resolved: 0,
				withheld: 0,
				expired,
				selfRefused: 0,
				selfInbound: 0,
				unparsed: 0,
				unmatched: 0,
			});
			return;
		}

		// Step 3 — ask, then write each resolution through the one predicate.
		const resolutions = await deps.telephony.resolveCounterparties({
			since: new Date(now.getTime() - COUNTERPARTY_WINDOW_MS),
			until: now,
		});

		const self =
			opts.selfNumber === undefined
				? null
				: canonicalCounterpartyNumber(opts.selfNumber);

		let resolved = 0;
		let withheld = 0;
		let selfRefused = 0;
		let selfInbound = 0;
		let unparsed = 0;
		const matched = new Set<string>();

		for (const resolution of resolutions) {
			if (!pendingSids.has(resolution.callSid)) continue;
			if (resolution.outcome === "unparsed") {
				// Vendor format drift, not a fact about the caller: write NOTHING,
				// leave it `pending` (a later sweep may read it after a fix; the
				// 24 h expiry still ends it), and make it visible. Normally 0.
				unparsed += 1;
				matched.add(resolution.callSid);
				continue;
			}
			if (resolution.outcome === "withheld") {
				const wrote = await writePending(deps, resolution.callSid, {
					counterpartyState: "withheld",
					counterpartyE164: null,
					counterpartyNameHint: null,
				});
				if (wrote) {
					withheld += 1;
					matched.add(resolution.callSid);
				}
				continue;
			}
			const e164 = canonicalCounterpartyNumber(resolution.rawNumber);
			if (e164 === null) continue; // unreachable for a mapper-validated number
			if (self !== null && e164 === self) {
				// The user's own GSM. Never stored either way. On an outbound (or
				// direction-unknown) leg it means the leg rule picked the wrong
				// leg — the pre-mortem #1 ALARM, `selfRefused`. On an inbound leg
				// the user really did call from their own GSM (a voice memo to
				// their own DID): not an alarm, counted apart as `selfInbound`.
				const wrote = await writePending(deps, resolution.callSid, {
					counterpartyState: "unavailable",
					counterpartyE164: null,
					counterpartyNameHint: null,
				});
				if (wrote) {
					if (resolution.direction === "inbound") selfInbound += 1;
					else selfRefused += 1;
					matched.add(resolution.callSid);
				}
				continue;
			}
			const wrote = await writePending(deps, resolution.callSid, {
				counterpartyState: "known",
				counterpartyE164: e164,
				counterpartyNameHint: resolution.nameHint ?? null,
			});
			if (wrote) {
				resolved += 1;
				matched.add(resolution.callSid);
			}
		}

		logRun({
			pending,
			resolved,
			withheld,
			expired,
			selfRefused,
			selfInbound,
			unparsed,
			unmatched: pending - matched.size,
		});
	} catch (err) {
		console.error(
			JSON.stringify({
				ts: Date.now(),
				event: "telephony.counterparty.failed",
				...(err instanceof ProviderError ? { errorCode: err.code } : {}),
				error: safeErrorMessage(err, MAX_LOGGED_ERROR_CHARS),
			}),
		);
	}
}

/**
 * THE write. `WHERE user_id = ? AND call_sid = ? AND counterparty_state =
 * 'pending'` — returns whether a row actually changed, so a resolution that
 * arrives after the conversation left `pending` (expired between the SELECT
 * and here, or a duplicate id) counts for nothing.
 */
async function writePending(
	deps: Pick<CounterpartySweepDeps, "db" | "userId">,
	callSid: string,
	values: {
		counterpartyState: "known" | "withheld" | "unavailable";
		counterpartyE164: string | null;
		counterpartyNameHint: string | null;
	},
): Promise<boolean> {
	const changed = await deps.db
		.update(conversations)
		.set(values)
		.where(
			and(
				eq(conversations.userId, deps.userId),
				eq(conversations.callSid, callSid),
				eq(conversations.counterpartyState, "pending"),
			),
		)
		.returning({ id: conversations.id });
	return changed.length > 0;
}

function logRun(counters: {
	pending: number;
	resolved: number;
	withheld: number;
	expired: number;
	selfRefused: number;
	selfInbound: number;
	unparsed: number;
	unmatched: number;
}): void {
	// Counters ONLY. No call id, no number, no hint — ever.
	console.error(
		JSON.stringify({
			ts: Date.now(),
			event: "telephony.counterparty.sweep",
			...counters,
		}),
	);
}
