// Zadarma's OUTBOUND request-signing recipe, ported to plain ESM for the
// onboarding smoke probe.
//
// WHY THIS FILE EXISTS AT ALL — it is a runtime boundary, not a copy-paste
// shortcut. `scripts/onboard.mjs` runs under bare `node` with no TypeScript
// transform, so it cannot import the canonical implementation at
// `src/server/telephony/zadarma-signature.ts`. The alternative (open-coding the
// recipe inside `smoke.mjs`) is what that file's header explicitly warns
// against: the two Zadarma SIGNED STRINGS differ (the digest encoding does NOT —
// one `base64(hex)` for both directions, corrected 2026-09-08), and getting one wrong
// produces a clean 401 that is INDISTINGUISHABLE from a bad key — so a drifted
// probe would confidently report "wrong key" about a perfectly good one, which
// is worse than having no probe.
//
// THE GUARD IS MECHANICAL, NOT A COMMENT: `zadarma-sign.test.ts` imports BOTH
// this module and the TypeScript original and asserts byte-identical output
// across a matrix that includes the two cases known to break naive ports
// (`%20`→`+`, and `%3A` staying encoded). Drift shows up as a red test, never as
// a mystery 401. If you change the recipe in either place, change it in both.
//
// Only the REQUEST recipe is ported. Webhook verification is a server concern
// and has no business in an operator CLI.
//
// Imports `node:crypto` only — no env, no network, no `~/env`.

import { createHash, createHmac } from "node:crypto";

/**
 * Serialize params the way Zadarma's PHP-derived signer does.
 *
 * The `%20`→`+` replace is INERT and mirrors the canonical implementation
 * verbatim (see the long note in `zadarma-signature.ts`): `URLSearchParams`
 * already serializes as `application/x-www-form-urlencoded`, which emits `+` for
 * a space, so the replace never fires. Kept identical to the original so the
 * differential test compares two literally-same functions rather than two that
 * happen to agree. The load-bearing part is `%3A`: the colons in a timestamp
 * stay ENCODED — the case naive "just decode it" ports get wrong.
 *
 * @param {Record<string, string>} params
 * @returns {string}
 */
function buildQuery(params) {
	return new URLSearchParams(params).toString().replace(/%20/g, "+");
}

/**
 * Sign an outbound Zadarma API request.
 *
 * `apiPath` is signed VERBATIM and must equal the path actually requested,
 * trailing slash included — the signature covers the path string, not the URL.
 * `format=json` is appended BEFORE signing, so the RETURNED `paramsString` is
 * what must go on the wire; a freshly rebuilt one would not match.
 *
 * @param {{ apiPath: string, params: Record<string, string>, userKey: string, secret: string }} input
 * @returns {{ paramsString: string, authorization: string }}
 */
export function signZadarmaRequest(input) {
	/** @type {Record<string, string>} */
	const withFormat = { ...input.params, format: "json" };
	/** @type {Record<string, string>} */
	const sorted = {};
	for (const key of Object.keys(withFormat).sort()) {
		sorted[key] = String(withFormat[key]);
	}
	const paramsString = buildQuery(sorted);
	const md5 = createHash("md5").update(paramsString).digest("hex");
	// HEX first, THEN base64 the hex TEXT — this is the step ports get wrong.
	const sha1Hex = createHmac("sha1", input.secret)
		.update(input.apiPath + paramsString + md5)
		.digest("hex");
	const signature = Buffer.from(sha1Hex).toString("base64");
	return { paramsString, authorization: `${input.userKey}:${signature}` };
}
