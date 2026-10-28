/**
 * One place that turns an arbitrary error into text that is safe for a log
 * line or for `processing_jobs.last_error` (`caller-identity-in-archive`
 * phase 2, FR-025).
 *
 * WHY THIS EXISTS. Before FR-025 the only phone numbers this system held were
 * the ones the user typed (`dialed_numbers`, `contacts`), and the only
 * redaction was `zadarma.ts`'s `\d{6,}` mask over vendor messages. FR-025 makes
 * `conversations` carry the OTHER party's number and presentation name, so the
 * first failed `UPDATE` that binds one would otherwise carry it straight into
 * the ~7-day Fly log window — which is NOT one of the places a number is
 * allowed to live. Two holes, both real today:
 *
 *   1. The old mask matched only an unbroken digit run and ran AFTER a 120-char
 *      cut, so `+48 500 100 200` (separators) and a number split by the cut both
 *      passed.
 *   2. `DrizzleQueryError` (drizzle-orm 0.45) formats its message as
 *      `Failed query: <sql>\nparams: <bound values>`. Every `err.message` sink
 *      therefore prints the bound values of the failed statement — already
 *      observable on `call.history_write_failed`, which binds the dialled
 *      `e164`.
 *
 * ORDER MATTERS: cut the `params:` tail, THEN mask, THEN truncate. Truncating
 * first re-opens hole 1; masking first cannot catch a presentation NAME inside
 * `params:` (no regex recognises free text), so the structural cut comes first.
 *
 * A name hint is otherwise protected STRUCTURALLY, not by this regex: the
 * mapper and resolver (phase 3) throw constant messages and never interpolate a
 * raw `clid`. The `"Name" <number>` pass below is defence in depth for a vendor
 * message that quotes one.
 */

/**
 * A telephony caller-id, `"Presentation Name" <+48…>` (Zadarma's `clid` shape).
 * Replaced whole, because the phone regex below cannot know that the quoted
 * text is a person's name. Bounded so a stray `"` cannot swallow a whole line,
 * and the angle-bracket part must START with a digit (or `+`): a failed SQL
 * statement quotes its identifiers, so `"a" < ? and "b" > ?` would otherwise
 * read as a caller-id and the diagnostic would vanish (impl-review F4).
 */
const CALLER_ID = /"[^"\n]{0,80}"\s*<\+?\d[^>\n]{0,39}>/g;

/**
 * A phone number as it appears in free text: 7–15 digits (E.164's ceiling),
 * optionally `+` or `00`, optionally a bracketed country code, with up to three
 * separator characters between digits (any Unicode space or tab, hyphen
 * family, slash, brackets). Bounded by non-alphanumerics so it does not fire inside an
 * id such as `in_1788618987.123` or a 40-char hex sid, and skips an ISO date
 * (`2026-10-19`). Known over-redaction: a bare 10-digit epoch timestamp masks
 * too — accepted, that was already true of the old `\d{6,}` mask. Known
 * under-redaction, pinned by the "known gaps" table in `redact.test.ts`:
 * digits glued to letters (`tel48…`), dot separators (a decimal number must
 * survive), runs of 6 or of 16+ digits. The old mask caught some of those and
 * ate every id instead; the boundary is the trade.
 */
const PHONE_NUMBER =
	/(?<![\p{L}\p{N}_])(?!\d{4}-\d{2}-\d{2}(?!\d))(?:\+|00)?(?:\(\s*\+?\d{1,4}\s*\)[\p{Zs}\t\-‐-―/]*)?\d(?:[\p{Zs}\t\-‐-―/()]{0,3}\d){6,14}(?![\p{L}\p{N}_])/gu;

/** The DrizzleQueryError bound-values tail; everything from here on is dropped. */
const DRIZZLE_PARAMS_TAIL = "\nparams:";

/** Replace caller-ids and phone numbers in free text with fixed placeholders. */
export function redactPhoneNumbers(text: string): string {
	return text.replace(CALLER_ID, "<caller>").replace(PHONE_NUMBER, "<phone>");
}

/**
 * The ONLY sanctioned way to turn an `unknown` error into a loggable string.
 * `redact-sinks.test.ts` fails the suite if a `console.error` or a `lastError`
 * write anywhere under `src/server` reads `.message` directly instead.
 *
 * @param maxChars cap applied AFTER masking (so a cut can never split a
 *   number back into the clear); a truncated message ends in `…`.
 */
export function safeErrorMessage(err: unknown, maxChars = 200): string {
	let text = sanitize(describe(err));
	// ONE level of `cause`, sanitized the same way. A `DrizzleQueryError`'s own
	// message names only the statement; the SQLite reason (`SQLITE_BUSY`,
	// `no such table`, `UNIQUE constraint failed`) lives in `cause.message`, and
	// without it a dead-lettered job's `last_error` would say what failed but
	// never why (impl-review F6). One level by construction — the cause's own
	// cause is ignored, so this cannot recurse.
	const cause = err instanceof Error ? err.cause : undefined;
	if (cause instanceof Error) text += ` (cause: ${sanitize(describe(cause))})`;
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Cut the DrizzleQueryError params tail, then mask. Order matters (see top). */
function sanitize(raw: string): string {
	const tail = raw.indexOf(DRIZZLE_PARAMS_TAIL);
	return redactPhoneNumbers(tail === -1 ? raw : raw.slice(0, tail));
}

/**
 * The raw text of an error, and NEVER a throw: this runs inside every `catch`
 * in both job workers, so a TypeError here would skip the `status='failed'`
 * write and leave the job stuck mid-flight (impl-review phase 2, F1). TS types
 * `message` as `string`, but a library can assign an object; `String()` on a
 * null-prototype object throws too.
 */
function describe(err: unknown): string {
	if (err instanceof Error) {
		if (typeof err.message === "string" && err.message.length > 0) {
			return err.message;
		}
		return typeof err.name === "string" ? err.name : "Error";
	}
	try {
		return String(err);
	} catch {
		return "[unprintable error]";
	}
}
