/**
 * Zadarma's HMAC. VENDOR FILE. There is exactly ONE digest encoding, used by
 * both directions; only the SIGNED STRING differs.
 *
 *   encoding        : base64( 40-char HEX digest of hmac_sha1(<string>, secret) )
 *   OUTBOUND request: <string> = apiPath + paramsString + md5(paramsString)
 *   INBOUND webhook : <string> = the event's own fields, concatenated
 *
 * ⚠️ THIS FILE USED TO CLAIM THE TWO RECIPES WERE **ASYMMETRIC** — request hex,
 * webhook RAW — and shipped a `verifyZadarmaWebhookSignature` that base64'd the
 * raw 20 bytes. That was FALSE, and it cost a production capture outage: from
 * the 2026-09-07 cutover until 2026-09-08 every genuine `NOTIFY_RECORD` Zadarma
 * delivered was answered **403**, while the incident was tracked as "Zadarma is
 * not delivering `NOTIFY_RECORD`" (OPT-232). It was delivering all along.
 *
 * The vendor's own source settles it — `zadarma/user-api-v1`, `lib/Client.php`:
 *
 *     public function encodeSignature($signatureString) {
 *         return base64_encode(hash_hmac('sha1', $signatureString, $this->secret));
 *     }
 *
 * PHP's `hash_hmac` takes `$binary = false` BY DEFAULT and therefore returns
 * lowercase HEX; `base64_encode` then encodes that hex *text*. `Api extends
 * Client` calls this ONE method for both the request auth header (`Client.php`
 * :130) and webhook verification (`Api.php`:717, against
 * `NotifyRecord::getSignatureString()`). One function on their side, so one
 * function on ours — `encodeZadarmaSignature` below — because two functions are
 * what let the two drift apart in the first place.
 *
 * HOW IT SURVIVED REVIEW, worth knowing before trusting the next such note: the
 * port WAS verified differentially against the official library, but only on the
 * REQUEST path (four vectors). The webhook path's "raw digest" was reasoned to,
 * never measured, and then a unit test froze the wrong answer as a vector and a
 * second test asserted the CORRECT recipe must be refused. A suite that confi-
 * dently pins a guess cannot fail on it; only a real delivery could, and that is
 * exactly what happened.
 *
 * Imports only `node:crypto`. Keeping `~/env` out is what lets the tests supply
 * their own key material.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Serialize params the way Zadarma's PHP-derived signer does.
 *
 * The `%20`→`+` substitution is INERT and kept only as a belt. This comment
 * used to claim `URLSearchParams.toString()` percent-encodes a space as `%20`
 * while PHP's `http_build_query` emits `+`; the second half is right, the first
 * is FALSE. `URLSearchParams` serializes as `application/x-www-form-urlencoded`,
 * which already emits `+` for a space, so the replace never fires on any output
 * this function can produce (a value containing the literal text `%20` comes out
 * as `%2520` — also unmatched). Measured 2026-09-07: deleting the `.replace(...)`
 * changes no byte on a matrix covering spaces, timestamps, a literal `%20`,
 * `~!()+*` and non-ASCII. The differential check against the official library
 * passed for the right reason — the serializations agree on their own — not
 * because of this line.
 *
 * The line stays because it cannot corrupt anything and documents the PHP
 * divergence it was reaching for. What actually matters here is `%3A`: the
 * colons in a timestamp stay ENCODED, and that is the case that breaks naive
 * "just decode it" ports.
 *
 * ONE RESIDUAL DIVERGENCE, harmless today: probed against PHP across
 * `~ ! ( ) ' +`, a literal `%20` and non-ASCII, every character agrees EXCEPT
 * `*` — `URLSearchParams` leaves it bare, PHP emits `%2A`. Every parameter we
 * sign today (`call_id`, `lifetime`, `start`, `format`) is machine-generated and
 * cannot contain one. If a later phase ever signs a free-text or user-supplied
 * value, fix this first: the failure is a 401 with exactly the
 * "indistinguishable from a bad key" symptom this file's header warns about.
 */
function buildQuery(params: Record<string, string>): string {
	return new URLSearchParams(params).toString().replace(/%20/g, "+");
}

/**
 * The vendor's `encodeSignature`, byte for byte: base64 of the HEX digest.
 *
 * The `Buffer.from(hex).toString("base64")` shape is not a flourish — it is the
 * whole point. `createHmac(...).digest("base64")` base64s the RAW 20 bytes and
 * yields a 28-character string; this yields 56, because it base64s 40 characters
 * of hex TEXT. Those two are what got swapped, and swapping them produces a
 * clean 401/403 indistinguishable from a wrong key. Shared by both call sites so
 * they cannot diverge again.
 */
export function encodeZadarmaSignature(
	signatureString: string,
	secret: string,
): string {
	const sha1Hex = createHmac("sha1", secret)
		.update(signatureString)
		.digest("hex");
	return Buffer.from(sha1Hex).toString("base64");
}

/**
 * Sign an outbound API request.
 *
 * `apiPath` is signed VERBATIM and MUST equal the path actually requested,
 * trailing slash included — the signature covers the path string, not the URL.
 * Measured 2026-09-05 across eight probes: the `<path>/` form authenticates, so
 * callers pin it rather than looping over variants (a loop would double every
 * request).
 *
 * `format=json` is appended BEFORE signing and is part of the signed string, so
 * the returned `paramsString` — not a freshly built one — is what must go on the
 * wire (query string for GET, body for POST/PUT/DELETE).
 */
export function signZadarmaRequest(input: {
	apiPath: string;
	params: Record<string, string>;
	userKey: string;
	secret: string;
}): { paramsString: string; authorization: string } {
	const withFormat: Record<string, string> = {
		...input.params,
		format: "json",
	};
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(withFormat).sort()) {
		sorted[key] = withFormat[key] as string;
	}
	const paramsString = buildQuery(sorted);
	const md5 = createHash("md5").update(paramsString).digest("hex");
	const signature = encodeZadarmaSignature(
		input.apiPath + paramsString + md5,
		input.secret,
	);
	return { paramsString, authorization: `${input.userKey}:${signature}` };
}

/**
 * The string Zadarma signs for a webhook: the concatenation of the event's own
 * fields, in the vendor's fixed order — NOT the whole body, NOT the URL, NOT a
 * timestamp.
 *
 * Consequence, and the reason this comment exists: a captured (body, signature)
 * pair replays forever. What neutralizes that is the partial unique index
 * `conv_user_callsid_uq` plus `onConflictDoNothing` in `webhooks.ts` — for this
 * provider that index is a SECURITY CONTROL, not a query optimization. Anyone
 * who later "simplifies" it opens a replay hole.
 *
 * ⚠️ AND THE CONCATENATION IS UNSEPARATED, which partly defeats that control.
 * The vendor joins the fields with nothing between them, so one signature
 * validates EVERY split of the same string — measured: `("in_pbx_1","rec_9")`,
 * `("in_pbx_","1rec_9")` and `("in_pbx","_1rec_9")` all verify against one
 * captured signature. Because `pbx_call_id` becomes `callSid`, that turns a
 * single captured pair into ~n forgeable `call_sid` values, each landing a
 * conversation + job the unique index cannot absorb. We cannot add a separator
 * (the format is Zadarma's), so the fix is SHAPE VALIDATION and it belongs in
 * Phase 2's `zadarma.ts`: refuse unless `pbx_call_id` and `call_id_with_rec`
 * each match their own format, which are disjoint enough to collapse the
 * ambiguity (observed: `in_`/`out_` + hex, vs. `<digits>.<digits>`). Confirm the
 * real formats on Phase 4's live run BEFORE pinning the regexes — two live
 * samples is not a spec.
 *
 * Returns `null` for an event whose signed field set we do not know — this
 * function will not verify against a guessed string.
 *
 * `null` MEANS "not a recording event", NOT "forged". Those are different
 * answers and the caller must not collapse them: `verifyZadarmaWebhookSignature`
 * maps `null` to `false` because a fail-closed primitive has no third value, but
 * a provider that forwards that `false` straight to `handleRecordingStatus`
 * answers 403 to all seven ordinary lifecycle events — on every call, at an
 * account-level notification URL, and against the plan's own "no 403 in
 * `fly logs`" criterion. Distinguish the two cases in the provider (see the
 * header of `zadarma-params.ts`); never by making verification return `true`.
 */
export function zadarmaWebhookSignatureString(
	params: Record<string, string>,
): string | null {
	if ((params.event ?? "").toUpperCase() !== "NOTIFY_RECORD") return null;
	return `${params.pbx_call_id ?? ""}${params.call_id_with_rec ?? ""}`;
}

/** Length-tolerant constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) {
		// Still run one comparison of equal length so the reject path does not
		// short-circuit measurably faster than a same-length mismatch.
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

/**
 * Verify a Zadarma webhook signature. Fail-closed, never throws.
 *
 * REGRESSION GUARD — this is a deliberate divergence from the official SDK.
 * `zadarma-api`'s `Webhook.ts:getWebhookEvent` compares with
 * `if (signature && signature !== expected) return null`, so an ABSENT or EMPTY
 * signature skips the comparison entirely and the event comes back marked
 * verified. Since the signature is the ONLY authorization a webhook has (the
 * route is excluded from the session gate precisely because of it), that turns
 * "send no header" into "authenticated". We refuse both cases BEFORE computing
 * anything, and a test pins it.
 */
export function verifyZadarmaWebhookSignature(input: {
	signature: string;
	params: Record<string, string>;
	secret: string;
}): boolean {
	if (!input.signature) return false;
	// An EMPTY SECRET is the second fail-open path, and it is not hypothetical:
	// `createHmac("sha1", "")` does NOT throw (measured), so without this line a
	// provider constructed with `env.ZADARMA_SECRET ?? ""` would verify every
	// webhook against a MAC any attacker can compute — and `ZADARMA_SECRET` is
	// `.optional()` in `src/env.js`, so nothing upstream forbids it. Phase 2's
	// constructor guard is the primary defense (mirroring `twilio.ts`); this line
	// is what makes the "Fail-closed" promise above true for the function ALONE.
	if (!input.secret) return false;
	const signed = zadarmaWebhookSignatureString(input.params);
	if (signed === null) return false;
	// SAME encoding as signZadarmaRequest — see this file's header. It was a RAW
	// digest here until 2026-09-08, which 403'd every real recording webhook.
	const expected = encodeZadarmaSignature(signed, input.secret);
	return safeEqual(input.signature, expected);
}
