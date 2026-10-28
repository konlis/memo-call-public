/**
 * Polish phone-number normalization to E.164 — one pure, testable rule.
 *
 * Two callers: the outbound mutation (`calls.placeOutbound`) and, since
 * `contact-directory` (2026-09-15), `contacts.create` / `contacts.update`. The
 * provider (`placeCall`) trusts `to` verbatim, so this is the single validation
 * boundary for what reaches Twilio. Returns the normalized E.164 string or
 * `null` (both callers map `null` → `BAD_REQUEST`). NEVER throws.
 *
 * ⚠️ DO NOT RELAX THIS FOR THE CONTACT BOOK. The second caller makes the rule
 * MORE load-bearing, not less: a contact's number is dialable, so a number this
 * function would have rejected is a number `placeCall` would receive unchecked.
 * It also doubles as write-time canonicalization — `contact_user_e164_uq`
 * dedupes "600 100 200" and "+48600100200" only because both arrive here first.
 * A contact with a foreign number is therefore not creatable, and that is a
 * deliberate product boundary. If one is ever needed, the right move is a
 * separate decision about a non-dialable number held OUTSIDE the `placeCall`
 * path — never a looser regex here.
 *
 * Accepted shapes (after stripping spaces / dashes / parens / dots):
 *   - `+48XXXXXXXXX`  (already E.164, 9 national digits)        → passthrough
 *   - `XXXXXXXXX`     (bare 9-digit national number)            → `+48XXXXXXXXX`
 *   - `0048XXXXXXXXX` (international-access-code form)           → `+48XXXXXXXXX`
 *   - `48XXXXXXXXX`   (country code without `+`)                → `+48XXXXXXXXX`
 * Everything else (wrong length, non-digits, another country code, a `+`
 * prefix that isn't `+48…`) → `null`.
 */
export function normalizePolishE164(raw: string): string | null {
	// Strip common human separators; keep `+` and digits to classify below.
	const cleaned = raw.replace(/[\s\-().]/g, "");

	// Already-plus forms: only `+48` + exactly 9 national digits is Polish E.164.
	if (cleaned.startsWith("+")) {
		return /^\+48\d{9}$/.test(cleaned) ? cleaned : null;
	}

	// `0048` international-access-code form → strip `00`, keep `48` + 9 digits.
	if (/^0048\d{9}$/.test(cleaned)) {
		return `+${cleaned.slice(2)}`;
	}

	// Country code without `+`: `48` + 9 national digits.
	if (/^48\d{9}$/.test(cleaned)) {
		return `+${cleaned}`;
	}

	// Bare national number: exactly 9 digits.
	if (/^\d{9}$/.test(cleaned)) {
		return `+48${cleaned}`;
	}

	return null;
}
