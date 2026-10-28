/**
 * Sanitized observability for the UNAUTHENTICATED telephony ingress.
 *
 * WHY THIS EXISTS. After the Zadarma cutover (2026-09-07) production stopped
 * capturing calls and the ingress could not say why, because it logged nothing
 * at all — the sole exception being `telephony.zadarma.malformed_id`. Three very
 * different states were therefore indistinguishable from this side, all of them
 * presenting as silence:
 *
 *   1. the provider posts nothing at all (its notification URL is not wired to
 *      the events we need);
 *   2. the provider posts the ordinary lifecycle events, which
 *      `handleRecordingStatus` answers 200 and drops (seven of Zadarma's eight
 *      types), and simply never posts the one that carries a recording;
 *   3. the provider posts the recording event and it is REFUSED (403) — a broken
 *      HMAC recipe.
 *
 * Only (3) is a bug in our code, and only (1) is a reason to go back to the
 * vendor. Guessing between them costs a live call each time. One line per
 * request settles it.
 *
 * WHY IT IS ITS OWN MODULE, not a `console.error` at the call site. Everything
 * this file logs arrives from a caller who has proven nothing — the ingress is
 * unauthenticated by construction, since the signature IS the auth and the
 * handshake runs BEFORE the provider has ever signed anything. Two hazards
 * follow, and both are handled here once rather than at three call sites:
 *
 *   - CONTENT. A caller-supplied string must never reach a log line verbatim.
 *     `token()` admits a conservative shape and otherwise emits a fixed
 *     placeholder, so an attacker cannot write bytes of their choosing into the
 *     log stream (forged JSON, ANSI escapes, a fake `job.done` line).
 *   - VOLUME. Fly's log window is ~7 days and there is NO database audit table:
 *     the auth trail from `auth/audit.ts` and the job trail from `jobs/audit.ts`
 *     live in that window and nowhere else. An unbounded line-per-request would
 *     hand an anonymous caller an EVICTION primitive against both — the same
 *     class of attack the phase-2 review removed from `zadarma.ts` (F3) and that
 *     `telephony-params-are-pure` exists to keep out of the mappers. The
 *     per-window budget below is what makes logging here safe; without it this
 *     module would be the very hole its neighbours are configured to prevent.
 *
 * The budget is deliberately generous against real traffic and tiny against a
 * flood: a busy day for a single-user instance is a few dozen notifications, so
 * `INGRESS_LOG_BUDGET` lines per minute cannot suppress a genuine event, while a
 * flood is capped at that same rate no matter how fast it arrives.
 *
 * State is module-level and in-process — lost on Machine restart, not shared
 * across Machines. Intentional, and the same trade `auth/throttle.ts` makes: a
 * diagnostic budget is not worth a write to the volume.
 */

/** Log lines this module will emit per window before it starts suppressing. */
export const INGRESS_LOG_BUDGET = 120;

/** Length of the rolling budget window, in ms. */
export const INGRESS_LOG_WINDOW_MS = 60_000;

/**
 * Shape a caller-controlled token must match to be logged verbatim.
 *
 * Deliberately an ALLOW-list on the whole string, not a strip-the-bad-characters
 * pass: a sanitizer that rewrites its input still emits attacker-chosen bytes
 * (whatever survives the filter), whereas a whole-string match emits either a
 * value we recognize as well-formed or a constant of ours. Every real value is
 * covered — Twilio's lifecycle statuses (`completed`, `in-progress`, `absent`)
 * and Zadarma's lowercased event names (`notify_start`, `notify_record`, …).
 */
const SAFE_TOKEN = /^[a-z0-9_-]{1,40}$/;

/** Emitted in place of a token that is empty. */
const EMPTY_TOKEN = "(empty)";

/** Emitted in place of a token that does not match `SAFE_TOKEN`. */
const UNRECOGNIZED_TOKEN = "(unrecognized)";

/**
 * Render a caller-controlled string as something safe to put in a log line.
 *
 * Exported for the tests, which pin the two placeholders — a future "just
 * truncate it" simplification would pass a test that only checked well-formed
 * input.
 */
export function token(raw: string): string {
	if (raw.length === 0) return EMPTY_TOKEN;
	return SAFE_TOKEN.test(raw) ? raw : UNRECOGNIZED_TOKEN;
}

let windowStartAt = 0;
let emittedInWindow = 0;
let suppressedInWindow = 0;

function write(fields: Record<string, string | number | boolean>): void {
	// `Date.now()` and `console.error`, matching `jobs/audit.ts` and
	// `auth/audit.ts` — one stderr stream must not carry two timestamp types or
	// two output channels.
	console.error(JSON.stringify({ ts: Date.now(), ...fields }));
}

/**
 * Claim one line from the budget.
 *
 * On the first call of a new window, any lines suppressed during the PREVIOUS
 * window are reported as a count. That report is what keeps suppression honest:
 * without it a flood would look identical to quiet, which is precisely the
 * confusion this module was built to end.
 */
function claimBudget(now: number): boolean {
	if (now - windowStartAt >= INGRESS_LOG_WINDOW_MS) {
		const carried = suppressedInWindow;
		windowStartAt = now;
		emittedInWindow = 0;
		suppressedInWindow = 0;
		if (carried > 0) {
			write({ event: "telephony.ingress.suppressed", count: carried });
		}
	}
	if (emittedInWindow >= INGRESS_LOG_BUDGET) {
		suppressedInWindow += 1;
		return false;
	}
	emittedInWindow += 1;
	return true;
}

/** What the handler did with this request. Ours, never the caller's. */
export type IngressOutcome =
	/** Body exceeded the cap — rejected 413 before it was parsed. */
	| "too-large"
	/** Body could not be read or decoded — rejected 400. */
	| "unreadable"
	/** Parsed, not the actionable event — 200, nothing written. */
	| "ignored"
	/** Actionable event, signature refused — 403. */
	| "forbidden"
	/** Actionable event, signature good, but the ids were unusable — 200. */
	| "incomplete"
	/** Actionable event accepted; a conversation + job were created. */
	| "enqueued"
	/** Actionable event accepted; already known, absorbed as a no-op (replay). */
	| "duplicate"
	/** Voice path: this provider has no inbound voice webhook — 404. */
	| "unsupported"
	/** Voice path: accepted, a call scenario was returned. */
	| "answered";

/**
 * One line per POST that reaches a telephony webhook handler.
 *
 * `kind` is the caller-controlled event/status name and is passed through
 * `token()`; `bodyBytes` is a COUNT, never the body — a telephony post carries
 * call identifiers and, on some providers, phone numbers, none of which this
 * project logs. `signed` reports only whether the provider's signature header
 * was present, never its value.
 */
export function logWebhookIngress(fields: {
	path: string;
	kind: string;
	bodyBytes: number;
	signed: boolean;
	outcome: IngressOutcome;
}): void {
	if (!claimBudget(Date.now())) return;
	write({
		event: "telephony.ingress.webhook",
		path: fields.path,
		kind: token(fields.kind),
		bodyBytes: fields.bodyBytes,
		signed: fields.signed,
		outcome: fields.outcome,
	});
}

/**
 * One line per URL-verification handshake GET.
 *
 * `matched` says whether the configured provider recognized the request as ITS
 * handshake (i.e. we answered the challenge) or not (404). The challenge VALUE
 * is never logged: it is caller-controlled, it is reflected in the response
 * body, and it carries no diagnostic information beyond "a handshake happened".
 *
 * This is a knowing amendment to the rule stated in `handleChallenge`, which
 * read "NO SIDE EFFECT is permitted here — no DB access, no logging, no
 * counter". The reason behind that rule was the unbounded-caller hazard, not
 * logging as such, and the budget above bounds it: the invariant is now "no
 * UNBOUNDED side effect". Nothing else changes — still no DB access, still
 * nothing derived from the challenge value.
 */
export function logChallengeIngress(fields: { matched: boolean }): void {
	if (!claimBudget(Date.now())) return;
	write({ event: "telephony.ingress.challenge", matched: fields.matched });
}

/** Test-only seam — `_`-prefixed, same convention as `auth/throttle.ts`. */
export function _resetIngressLogStateForTests(): void {
	windowStartAt = 0;
	emittedInWindow = 0;
	suppressedInWindow = 0;
}
