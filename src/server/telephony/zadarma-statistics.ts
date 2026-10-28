/**
 * Zadarma PBX-statistics response mapping. VENDOR FILE — the only place in the
 * repo that knows the shape of `/v1/statistics/pbx/?version=2`.
 *
 * Deliberately its own module, mirroring `zadarma-params.ts`: it imports NOTHING
 * but the vendor-neutral contract and that sibling leaf, so it can be read and
 * tested without dragging in `zadarma.ts`, `~/env`, a database or a network
 * client. `.dependency-cruiser.cjs` (`telephony-params-are-pure`) enforces that
 * — the rule's `from` pattern was widened to `*-statistics.ts` for this file.
 *
 * THE SECOND REASON THAT RULE COVERS THIS FILE, and the one to read before
 * touching anything below. The rows mapped here CARRY PHONE NUMBERS
 * (`destination`, `clid`). Since FR-025 a vendor-supplied number has exactly
 * ONE legitimate home — `conversations.counterparty_e164`, written by the
 * counterparty sweep (`jobs/counterparty.ts`) and by nothing else, which a
 * source guard enforces (`jobs/counterparty-write-path.test.ts`; the rule is
 * stated at the column in `schema.ts`). Capture reconciliation is NOT that
 * path: it has nowhere legitimate to write a number FROM HERE, and the
 * contact book and dialing history hold only numbers the user typed or chose
 * to copy. Capture reconciliation must therefore hold
 * numbers in process memory and NOWHERE else. Being cut off from `~/env`, the
 * database and the logger is what makes that structural rather than a promise:
 * this module has nothing to leak INTO. The other half is `PendingRecording`
 * itself, which has no field a number could occupy. Do not destructure
 * `destination` or `clid` here — not even to ignore them.
 *
 * SINCE FR-025 (`caller-identity-in-archive`, 2026-10-19) those two fields DO
 * have one legitimate reader: `zadarma-counterparty.ts`, a sibling leaf under
 * the same purity rule, which maps them onto `CounterpartyResolution` for the
 * resolver in `jobs/counterparty.ts` to write onto `conversations`. That is a
 * second request over the same endpoint, not a second output of this module —
 * so the prohibition above, and the source test that pins it, are unchanged.
 *
 * WHAT THE VENDOR RETURNS (measured live 2026-09-08, and again during the
 * reconciliation frame):
 *   - `version=2` is NON-NEGOTIABLE. Without it the response omits
 *     `pbx_call_id` ENTIRELY while otherwise looking perfectly well-formed —
 *     the failure mode is an empty debt ledger, not an error.
 *   - ONE conversation yields MANY rows: a trunk leg (`sip: "0"`) and an
 *     extension leg (`sip: "100"`), sharing one `pbx_call_id`. TWO selections
 *     are needed, not one, and they are independent:
 *       (a) filter by `is_recorded` FIRST — taking the first row for a
 *           `pbx_call_id` would call a recorded conversation unrecorded and
 *           silently drop the note;
 *       (b) among the rows that survive, take the one with the greatest
 *           `seconds`. The short leg is the RING, and fetching it yields a few
 *           seconds of ringback that transcribes into a plausible-looking empty
 *           note rather than an error.
 *     This header used to claim "only the extension leg carries `is_recorded`
 *     true", which would have made (b) an idle tie-break. Phase-1 F7 measured
 *     otherwise on two live multi-leg conversations, confronted with the
 *     `recording_sid` the vendor itself delivered by `NOTIFY_RECORD`: 126 s over
 *     10 s, and 69 s over 8 s. Two samples are not a spec — but they are more
 *     than the response ordering the first version relied on. Do NOT select on
 *     `sip` instead: that value is PBX configuration (this account's recording
 *     extension happens to be `100`) and would silently stop matching on an
 *     instance numbered differently.
 *   - `is_recorded` means "the audio is STILL AT THE VENDOR", not "this call was
 *     recorded". Proven on one row on one day: `true` in the morning, `false`
 *     after `runDeleteSweep` removed the audio. That inversion is what makes the
 *     resident set an exact ledger of the capture debt.
 *   - `call_id` (e.g. `1788883091.244520`) is the token `/v1/pbx/record/request/`
 *     exchanges for a download link — the same value the webhook delivers as
 *     `call_id_with_rec`. Statistics do NOT carry `call_id_with_rec`, so `call_id`
 *     is the only route to the audio here.
 */

import type { PendingRecording } from "~/server/telephony/types";
import { PBX_CALL_ID_SHAPE } from "~/server/telephony/zadarma-params";

/**
 * Is this row's recording still resident at the vendor? `null` means the value
 * was in NO representation this mapper knows.
 *
 * An ALLOW-LIST, not a truthiness test, and the difference is not academic: the
 * field arrives as a JSON boolean on some rows and as a STRING on others, and
 * `Boolean("false")` is `true`. A truthy check would mark every already-deleted
 * recording as outstanding debt and re-backfill conversations forever.
 *
 * WHY THE THIRD ANSWER EXISTS. An allow-list read as "anything else is not
 * resident" is safe for ONE odd row — a false negative costs a single missed
 * backfill and the next sweep sees it again. It is NOT safe for a REPRESENTATION
 * CHANGE: if the vendor ever starts sending `"yes"` / `"Y"`, every row falls
 * outside the list, every sweep misses everything forever, the debt ledger reads
 * permanently empty, and nothing errors anywhere. That is precisely the silent
 * blindness this feature exists to abolish — so the caller turns "not one
 * recognized value in a non-empty response" into a loud failure, not into `[]`.
 */
function readResident(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return null;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") return true;
		if (normalized === "false" || normalized === "0" || normalized === "")
			return false;
		return null;
	}
	return null;
}

/**
 * Read one string field, STRING ONLY — a JSON number yields `""` and the row is
 * dropped.
 *
 * This used to accept a number and pass it through `String()`, which looked
 * tolerant and was actively dangerous. `String(JSON.parse("1788883091.244520"))`
 * is `"1788883091.24452"` — the trailing zero is destroyed, because a double
 * only round-trips to its SHORTEST decimal form, not to the vendor's lexeme.
 * That exact value is the one `frame.md` measured as `recording_sid == call_id`,
 * so the corruption would hit a real recording: a mangled `recordingSid` fetches
 * no audio, and by then the `conversations` row already exists, so the genuine
 * `NOTIFY_RECORD` that arrives later is absorbed by `conv_user_callsid_uq` as a
 * no-op. Permanent silent loss of the note — from the reconciler.
 *
 * MEASURED 2026-09-09: the vendor QUOTES these fields (the probe printed
 * `1788883091.244520` with its trailing zero intact; a JSON number could not
 * have survived the trip). So this is a trap we are closing, not a bug we hit.
 * Dropping a row costs one sweep — the next one sees it again; corrupting an id
 * costs the recording. Never trade in that direction.
 */
function readString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

/**
 * Leg duration in seconds, used ONLY to choose between legs of one conversation
 * (see `mapZadarmaPendingRecordings`). An unreadable value sorts last rather
 * than throwing — a missing duration must not cost us the whole recording.
 */
function readSeconds(row: Record<string, unknown>): number {
	const value = row.seconds;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : -1;
	}
	return -1;
}

/**
 * How many rows the vendor actually returned, or `null` when the envelope is not
 * the shape this module knows (same discrimination as the mapper).
 *
 * Exists so the CALLER can detect a truncated page without learning the response
 * shape — `/v1/statistics/pbx/` caps a page at 1000 rows and says so nowhere in
 * the body. The mapped list cannot answer this: it is already filtered and
 * deduped, so a full page of non-resident rows maps to `[]` and looks exactly
 * like a quiet window. Counting the RAW rows is the only honest signal.
 */
export function countZadarmaStatisticsRows(envelope: unknown): number | null {
	if (typeof envelope !== "object" || envelope === null) return null;
	const stats = (envelope as Record<string, unknown>).stats;
	if (stats === undefined || stats === null) return 0;
	if (!Array.isArray(stats)) return null;
	return stats.length;
}

/**
 * What a scan of one statistics envelope found — the mapped list PLUS why rows
 * were discarded (full-review F3).
 *
 * WHY THE COUNTERS EXIST. Three `continue`s in the loop below drop rows, and
 * until F3 every one of them was silent. The phase-1 F8 guard catches only the
 * TOTAL case (`stats.length > 0 && recognized === 0`); a PARTIAL drift slipped
 * through — e.g. the vendor keeping `false` but switching its true
 * representation, which leaves `recognized > 0` while every resident row is
 * skipped, so the ledger reads permanently empty and nothing errors.
 *
 * The id-shape drop is the sharper case. `zadarma-params.ts` records that the
 * 40-hex shape is "STILL NOT A SPEC — one sample per direction". On the WEBHOOK
 * path a drift there is loud (403 + a named `telephony.zadarma.malformed_id`
 * line); on THIS path it was mute, because this module is bound by
 * `telephony-params-are-pure` and cannot log. So one vendor change would take
 * out both capture routes, one of them invisibly, with `{scanned: 0}` — the
 * exact indistinguishability this whole feature exists to abolish — as the only
 * symptom.
 *
 * The counters are returned, never logged: purity is preserved and `zadarma.ts`,
 * which IS allowed to log, decides what to say. That split is the same one
 * `readResident` relies on for `null`.
 */
export type ZadarmaStatisticsScan = {
	/** Rows that survived every filter, deduped to one per `pbx_call_id`. */
	recordings: PendingRecording[];
	/** Rows the vendor returned, before any filter. */
	rawRows: number;
	/** Rows whose `is_recorded` spoke no representation we know. */
	droppedUnrecognized: number;
	/** RESIDENT rows whose `pbx_call_id` failed `PBX_CALL_ID_SHAPE`. */
	droppedBadId: number;
	/** RESIDENT rows with a well-formed id but no `call_id` to fetch audio by. */
	droppedNoCallId: number;
};

/**
 * Map a `/v1/statistics/pbx/` success envelope onto the recordings still
 * resident at the vendor, plus the counters saying what had to be discarded.
 * `mapZadarmaPendingRecordings` below is the thin projection of this.
 *
 * Returns `null` — NOT an empty array — when the envelope does not have the
 * shape this mapper knows. The caller turns that into `ProviderError` with code
 * `invalid_response`. The two answers must never be collapsed: `[]` means "the
 * window genuinely held no resident recordings", `null` means "we could not
 * tell", and reading the second as the first is exactly the silent-blindness
 * class this whole feature exists to abolish.
 *
 * A MISSING `stats` key is treated as `[]`, not as `null`. That is a judgement
 * call, not a measurement: the vendor's behaviour on an empty window is not
 * pinned (the spike printed the raw body precisely because it was unsure), and
 * failing the sweep every five minutes on a quiet account would be worse than
 * the blind spot. A `stats` that is PRESENT but not an array is a genuine shape
 * change and does yield `null`.
 *
 * WHICH LEG, when a conversation reports more than one resident row: the one
 * with the greatest `seconds`. Not a tie-breaking convenience — a correctness
 * rule, and picking wrong fails SILENTLY. The short leg of an inbound call is
 * the RING, so fetching it yields a few seconds of ringback that transcribes
 * into a plausible-looking empty note rather than into an error.
 * MEASURED 2026-09-09 on two live multi-leg conversations, checked against the
 * VENDOR'S OWN answer — the `recording_sid` each one delivered by
 * `NOTIFY_RECORD`, read back out of the production database, i.e. evidence whose
 * provenance is independent of this code (`lessons.md`): `in_d30d9346…` spans a
 * 10 s and a 126 s leg and the vendor named the 126 s one; `in_ce8a39d5…` spans
 * 8 s and 69 s and the vendor named the 69 s one. Two samples is not a spec, but
 * it beats the arbitrary response order this used to depend on, and it agrees
 * with the `sip: "0"` trunk / `sip: "100"` extension split in `CLAUDE.md`.
 * Selecting on `sip` directly was REJECTED: that value is PBX configuration
 * (this account's recording extension happens to be 100), so it would silently
 * stop matching on any instance numbered differently — whereas "the leg that
 * lasted longest" holds regardless of numbering.
 *
 * Rows are dropped, never repaired, when `pbx_call_id` does not match
 * `PBX_CALL_ID_SHAPE` or `call_id` is empty. `pbx_call_id` becomes
 * `conversations.call_sid`, the anchor of the `conv_user_callsid_uq` index that
 * is a SECURITY control under this provider — the same predicate has to hold
 * whether an id arrives by webhook or is read back out of statistics, which is
 * why the regex lives in `zadarma-params.ts` and not in either caller.
 *
 * No timing fields are populated, deliberately. `callstart` is expressed in
 * ACCOUNT time (UTC+2 as measured), and this plan applies that offset in exactly
 * ONE direction — when BUILDING the window parameters — never when interpreting
 * results. Parsing it back here would be a second, independent shift and the
 * failure mode is silent: a `started_at` two hours off, indistinguishable from a
 * correct one. Leaving all three unset lands precisely the NULL columns the
 * Zadarma webhook path already leaves (`zadarma-params.ts` populates none of
 * them either), which is what makes a backfilled conversation indistinguishable
 * from a captured one.
 */
export function scanZadarmaStatistics(
	envelope: unknown,
): ZadarmaStatisticsScan | null {
	if (typeof envelope !== "object" || envelope === null) return null;
	const stats = (envelope as Record<string, unknown>).stats;
	if (stats === undefined || stats === null)
		return {
			recordings: [],
			rawRows: 0,
			droppedUnrecognized: 0,
			droppedBadId: 0,
			droppedNoCallId: 0,
		};
	if (!Array.isArray(stats)) return null;

	const best = new Map<
		string,
		{ recording: PendingRecording; seconds: number }
	>();
	let recognized = 0;
	let droppedUnrecognized = 0;
	let droppedBadId = 0;
	let droppedNoCallId = 0;
	for (const entry of stats) {
		if (typeof entry !== "object" || entry === null) {
			droppedUnrecognized += 1;
			continue;
		}
		const row = entry as Record<string, unknown>;
		// Resident FIRST: one conversation spans several legs and only the
		// extension leg carries the audio. Deduping before this filter would pick
		// the trunk leg and call a recorded conversation unrecorded.
		const resident = readResident(row.is_recorded);
		if (resident === null) {
			droppedUnrecognized += 1;
			continue;
		}
		recognized += 1;
		if (!resident) continue;
		const callSid = readString(row, "pbx_call_id");
		if (!PBX_CALL_ID_SHAPE.test(callSid)) {
			droppedBadId += 1;
			continue;
		}
		const recordingSid = readString(row, "call_id");
		if (recordingSid.length === 0) {
			droppedNoCallId += 1;
			continue;
		}
		// LONGEST LEG WINS — not first-seen. See the leg-selection note in this
		// function's doc comment: the short leg is the ring, not the conversation.
		const seconds = readSeconds(row);
		const incumbent = best.get(callSid);
		if (incumbent === undefined || seconds > incumbent.seconds) {
			best.set(callSid, { recording: { callSid, recordingSid }, seconds });
		}
	}
	// A non-empty response in which NOT ONE row spoke a representation we know is
	// not "nothing is pending" — it is a vendor whose field changed shape. Fail it
	// the way an unrecognized envelope fails, so the sweep logs a named error
	// instead of reporting a permanently empty ledger. See `readResident`.
	if (stats.length > 0 && recognized === 0) return null;
	return {
		recordings: [...best.values()].map((candidate) => candidate.recording),
		rawRows: stats.length,
		droppedUnrecognized,
		droppedBadId,
		droppedNoCallId,
	};
}

/**
 * The list alone, for callers that do not care why anything was dropped.
 *
 * Kept as the module's original surface so the mapper's contract tests — the
 * ones that pin the three-state `[] / null / rows` discrimination — keep
 * exercising it directly.
 */
export function mapZadarmaPendingRecordings(
	envelope: unknown,
): PendingRecording[] | null {
	const scan = scanZadarmaStatistics(envelope);
	return scan === null ? null : scan.recordings;
}
