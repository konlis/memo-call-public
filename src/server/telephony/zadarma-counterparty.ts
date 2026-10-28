/**
 * Zadarma counterparty mapping (FR-025, `caller-identity-in-archive`). VENDOR
 * FILE — the ONLY module in the repo allowed to name the phone-number fields
 * of `/v1/statistics/pbx/?version=2` (`clid`, `destination`) in executable
 * code. `zadarma-statistics.ts` reads the same response and is forbidden to
 * touch them (its own source test pins that); the two modules are deliberately
 * NOT merged so that prohibition stays exactly as it was.
 *
 * Same purity contract as its siblings: imports nothing but the vendor-neutral
 * `types.ts` and the `*-params.ts` leaf (`.dependency-cruiser.cjs`,
 * `telephony-params-are-pure`), no `console` / `process` / `fetch`
 * (`zadarma-counterparty.test.ts` scans the source for them). It returns
 * resolutions; it never throws, never logs, never interpolates a raw `clid`
 * into anything — a presentation NAME is free text that no redaction regex can
 * recognise, so the only protection it has is never leaving this function
 * except as the `nameHint` field. What writes the result to the database is
 * `jobs/counterparty.ts`, and nothing else.
 *
 * THE LEG RULE — MEASURED, not inferred (a spike on two live calls,
 * 2026-10-19):
 *
 *   - `in_…`: the caller's number AND presentation name are in `clid`, as
 *     `"Name" <+48…>`, IDENTICAL on every leg of the conversation (trunk,
 *     extension, voicemail). `destination` is the user's OWN DID and is
 *     ignored. Any leg will do; the first that yields a usable number wins.
 *   - `out_…`: the dialled party is in `destination` — a JSON NUMBER
 *     (`48XXXXXXXXX`, no `+`, no quotes) — on the ONE PBX leg such a call has
 *     (if there were several, the longest, consistent with the reconciler).
 *     `clid` on an outbound leg is the USER'S OWN GSM (`"" <+<own number>>`):
 *     reading it would store the owner's number on every call they place, and
 *     the resolver's self-refusal would then turn every outbound call into
 *     `unavailable`. No presentation name exists on `out_` (`clid` is `""`),
 *     so `nameHint` is never set for it.
 *
 * `is_recorded` is NOT consulted. For the reconciler it is the ledger; here it
 * is noise — a conversation already processed has had its audio deleted and
 * reports `"false"`, and that row is exactly the one this mapper is looking for.
 *
 * THREE ANSWERS, never collapsed (same discipline as `scanZadarmaStatistics`):
 * `null` = the envelope is not a shape this module knows (caller → `invalid_
 * response`); a resolution with `outcome: "withheld"` = the vendor's row was
 * there but carried no usable number (CLIR, "Anonymous", empty); NO ENTRY for
 * a `callSid` = the window held no row for it, and the resolver leaves that
 * conversation `pending` for a later sweep.
 */

import type { CounterpartyResolution } from "~/server/telephony/types";
import { PBX_CALL_ID_SHAPE } from "~/server/telephony/zadarma-params";

/** E.164 bounds on the digit count of a number this mapper will hand out. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/** Hard cap on a presentation name; the vendor documents no limit. */
const MAX_NAME_HINT_CHARS = 60;

/**
 * Control characters in a presentation name — vendor text, i.e. untrusted.
 * C0/C1 controls become a space; every FORMAT character (`\p{Cf}`) is dropped:
 * the bidi marks, embeddings, overrides and isolates (rendered next to the
 * number, a U+202E would visually reorder it) and the zero-width ones
 * (U+200B, U+FEFF, U+2060 — a hint made only of those would show as an
 * invisible "name" in place of the number; full-plan impl-review F4). Cost
 * accepted: U+200D is `Cf` too, so a joined emoji in a name falls apart.
 */
const CONTROL_CHARS = /\p{Cc}/gu;
const FORMAT_CHARS = /\p{Cf}/gu;

/** The `<…>` part of a caller-id, when one is present. */
const ANGLE_PART = /<([^>]*)>/;

/** The leading `"…"` part of a caller-id — the presentation name. */
const QUOTED_PART = /^\s*"([^"]*)"/;

/** Separators a human-rendered number may carry; stripped before validation. */
const SEPARATORS = /[\s\-()./]/g;

type Leg = { clid: unknown; destination: unknown; seconds: number };

/**
 * A `+`-or-nothing prefix plus 7–15 digits out of whatever the vendor put in a
 * number-bearing field, or `null`. Lexical only: `00` → `+` because that is a
 * spelling, not a country decision. Everything semantic (which country, which
 * canonical form) belongs to the resolver, which has `normalizePolishE164`.
 */
function readNumber(raw: unknown): string | null {
	let text: string;
	if (typeof raw === "number") {
		// `destination` arrives as a JSON number on an outbound leg. Only an
		// integer renders back to the vendor's digits; anything else is not a
		// phone number, whatever it is.
		if (!Number.isSafeInteger(raw) || raw <= 0) return null;
		text = String(raw);
	} else if (typeof raw === "string") {
		text = numberPart(raw);
	} else {
		return null;
	}
	let cleaned = text.replace(SEPARATORS, "");
	if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;
	const match = /^(\+?)(\d+)$/.exec(cleaned);
	if (!match) return null;
	const digits = match[2] ?? "";
	if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
	return `${match[1] ?? ""}${digits}`;
}

/**
 * The part of a caller-id string that should hold the number. The `<…>` is
 * read AFTER the quoted presentation name: the name is caller/carrier text and
 * may itself contain `<…>` — `"Biuro <22 123 45 67>" <+48500100200>` would
 * otherwise yield the name's digits as the caller's number, a terminal `known`
 * with the wrong party (impl-review F1, 2026-10-20).
 */
function numberPart(raw: string): string {
	const quoted = QUOTED_PART.exec(raw);
	const rest = quoted ? raw.slice(quoted[0].length) : raw;
	const angle = ANGLE_PART.exec(rest);
	return (angle ? angle[1] : rest) ?? "";
}

/**
 * Why a number-bearing field yielded no number: `withheld` when it carries no
 * number at all (absent, null, empty, a word with no digit — CLIR's shapes),
 * `unparsed` when it carries something number-like this mapper cannot read
 * (digits in an unknown layout, a non-integer or out-of-range JSON number, a
 * value of an unexpected type). Only the first is a fact about the caller; the
 * second is a fact about the vendor's format, and must not be stored as the
 * first. CLIR's real shape was NOT measured in that spike, so "no digit" is the
 * conservative line: anything carrying a digit is presumed to be a number.
 */
function missingNumberOutcome(raw: unknown): "withheld" | "unparsed" {
	if (raw === undefined || raw === null) return "withheld";
	if (typeof raw === "string") {
		return /\d/.test(numberPart(raw)) ? "unparsed" : "withheld";
	}
	return "unparsed";
}

/**
 * The quoted presentation name of a caller-id, trimmed and capped, or
 * `undefined` when there is none, it is blank, or it merely restates the number
 * (some carriers present `"+48…" <+48…>` or the national form `"500 100 200"
 * <+48500100200>`; a hint equal to the number would be shown as a name and is
 * not one). A hint that is a DIFFERENT number is kept — it is information.
 */
function readNameHint(clid: unknown, number: string): string | undefined {
	if (typeof clid !== "string") return undefined;
	const quoted = QUOTED_PART.exec(clid);
	if (!quoted) return undefined;
	const hint = (quoted[1] ?? "")
		.replace(CONTROL_CHARS, " ")
		.replace(FORMAT_CHARS, "")
		.trim()
		.slice(0, MAX_NAME_HINT_CHARS)
		.trim();
	if (hint.length === 0) return undefined;
	if (restatesNumber(hint, number)) return undefined;
	return hint;
}

/**
 * Is `hint` just the number again? True when the hint is nothing but digits
 * and separators, and its digits are the number's digits or a national-form
 * suffix of them (≥ 7 digits, so a short numeric label is not swallowed).
 */
function restatesNumber(hint: string, number: string): boolean {
	const stripped = hint.replace(SEPARATORS, "");
	const match = /^(?:\+|00)?(\d+)$/.exec(stripped);
	if (!match) return false;
	const hintDigits = match[1] ?? "";
	const numberDigits = number.replace(/^\+/, "");
	return hintDigits.length >= MIN_DIGITS && numberDigits.endsWith(hintDigits);
}

/** Leg duration, for the outbound longest-leg pick; unreadable sorts last. */
function readSeconds(row: Record<string, unknown>): number {
	const value = row.seconds;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : -1;
	}
	return -1;
}

function resolveInbound(callSid: string, legs: Leg[]): CounterpartyResolution {
	let unparsed = false;
	for (const leg of legs) {
		const rawNumber = readNumber(leg.clid);
		if (rawNumber === null) {
			if (missingNumberOutcome(leg.clid) === "unparsed") unparsed = true;
			continue;
		}
		const nameHint = readNameHint(leg.clid, rawNumber);
		return nameHint === undefined
			? { callSid, outcome: "known", rawNumber, direction: "inbound" }
			: {
					callSid,
					outcome: "known",
					rawNumber,
					nameHint,
					direction: "inbound",
				};
	}
	return { callSid, outcome: unparsed ? "unparsed" : "withheld" };
}

function resolveOutbound(callSid: string, legs: Leg[]): CounterpartyResolution {
	let longest: Leg | undefined;
	for (const leg of legs) {
		if (longest === undefined || leg.seconds > longest.seconds) longest = leg;
	}
	if (longest === undefined) return { callSid, outcome: "withheld" };
	const rawNumber = readNumber(longest.destination);
	return rawNumber === null
		? { callSid, outcome: missingNumberOutcome(longest.destination) }
		: { callSid, outcome: "known", rawNumber, direction: "outbound" };
}

/**
 * Map a `/v1/statistics/pbx/` success envelope onto one resolution per
 * well-formed `pbx_call_id` it contains.
 *
 * Returns `null` — NOT an empty array — when the envelope does not have the
 * shape this mapper knows; the caller turns that into `invalid_response`. A
 * MISSING `stats` key is `[]`, matching the reconciler's judgement call about
 * the vendor's unpinned behaviour on an empty window. Rows whose `pbx_call_id`
 * fails `PBX_CALL_ID_SHAPE` are skipped: the id is matched against
 * `conversations.call_sid`, which only ever holds ids that passed the same
 * regex, so such a row can match nothing anyway.
 */
export function mapZadarmaCounterparties(
	envelope: unknown,
): CounterpartyResolution[] | null {
	if (typeof envelope !== "object" || envelope === null) return null;
	const stats = (envelope as Record<string, unknown>).stats;
	if (stats === undefined || stats === null) return [];
	if (!Array.isArray(stats)) return null;

	const legsByCall = new Map<string, Leg[]>();
	for (const entry of stats) {
		if (typeof entry !== "object" || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const callSid = typeof row.pbx_call_id === "string" ? row.pbx_call_id : "";
		if (!PBX_CALL_ID_SHAPE.test(callSid)) continue;
		const legs = legsByCall.get(callSid) ?? [];
		legs.push({
			clid: row.clid,
			destination: row.destination,
			seconds: readSeconds(row),
		});
		legsByCall.set(callSid, legs);
	}

	const resolutions: CounterpartyResolution[] = [];
	for (const [callSid, legs] of legsByCall) {
		resolutions.push(
			callSid.startsWith("out_")
				? resolveOutbound(callSid, legs)
				: resolveInbound(callSid, legs),
		);
	}
	return resolutions;
}
