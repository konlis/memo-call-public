/**
 * Zadarma notification form-field mapping. VENDOR FILE — the only place in the
 * repo that knows Zadarma's event names and field names.
 *
 * Deliberately its own module, mirroring `twilio-params.ts`: it imports NOTHING
 * but the `RecordingEvent` type, so it can be read (and tested) without dragging
 * in `zadarma.ts`, `~/env`, or a network client. Same split as
 * `auth/password-rules.ts` out of `auth/password.ts` (F-03).
 *
 * THE ONE THING TO UNDERSTAND HERE. Zadarma has a single notification URL per
 * ACCOUNT and posts EVERY event type to it — `notify_start`, `notify_internal`,
 * `notify_answer`, `notify_end`, `notify_out_start`, `notify_out_end`,
 * `notify_record`, `notify_ivr`. Only `NOTIFY_RECORD` means "a recording is
 * ready". The other seven are meant to cost the handler nothing: they map onto a
 * `recordingStatus` that is simply not `"completed"`, and the existing
 * early-return in `webhooks.ts` (`recordingStatus !== "completed"` → fast no-op)
 * swallows them with ZERO changes to the handler.
 *
 * REACHING that no-op took one change OUTSIDE this file, and knowing which one
 * is the point. `handleRecordingStatus` used to verify the signature BEFORE
 * calling `parseRecordingEvent`, and `zadarmaWebhookSignatureString` knows the
 * signed field set of `NOTIFY_RECORD` only — so the other seven got a 403 each
 * and never reached the mapping below. The fix (phase 3 / FU-3) was to reorder
 * the HANDLER: parse first, demand a signature only for the event it acts on.
 * The forbidden shape was `verifySignature → true` for unknown events, which
 * would re-create the vendor-SDK gap `zadarma-signature.ts` exists to close —
 * the provider stays fail-closed, the policy lives in the layer that knows what
 * the events mean. The pairing is pinned end-to-end against the REAL provider in
 * `webhooks.integration.test.ts`, not against a stub that accepts anything.
 */

import type { RecordingEvent } from "~/server/telephony/types";

/** The event name that carries a finished recording. */
const RECORDING_EVENT = "NOTIFY_RECORD";

/**
 * Is this notification the one event that carries a finished recording?
 *
 * Exported so `zadarma.ts` can gate its id-shape check on the same predicate the
 * mapping below uses, instead of restating the vendor's event name a third time
 * in this directory. Case-insensitive for the same reason the mapping is: the
 * vendor's own docs write it both ways.
 */
export function isZadarmaRecordingEvent(
	params: Record<string, string>,
): boolean {
	return (params.event ?? "").toUpperCase() === RECORDING_EVENT;
}

/**
 * Map raw Zadarma notification form params onto the vendor-neutral
 * `RecordingEvent`.
 *
 * `NOTIFY_RECORD` carries exactly THREE fields — `event`, `pbx_call_id`,
 * `call_id_with_rec` — so `from`/`to`/`recordingDurationMs`/`startedAt`/`endedAt`
 * stay `undefined`. Those columns are nullable and no `.tsx` renders them; the
 * timing data lives in `NOTIFY_END`, a different event we deliberately ignore.
 *
 * `recordingStatus: "completed"` is SYNTHESIZED, not read: Zadarma has no status
 * field because the arrival of this event IS the completion. Every other event
 * yields its own lowercased name, which no consumer treats as terminal.
 *
 * An absent `event` yields `recordingStatus: ""` — also not `"completed"`, so a
 * malformed post is a no-op rather than a half-processed recording.
 */
export function parseZadarmaRecordingEvent(
	params: Record<string, string>,
): RecordingEvent {
	const event = params.event ?? "";
	if (!isZadarmaRecordingEvent(params)) {
		return {
			callSid: "",
			recordingSid: "",
			recordingStatus: event.toLowerCase(),
		};
	}
	return {
		// pbx_call_id anchors `conv_user_callsid_uq`; call_id_with_rec is the
		// token handed back to `/v1/pbx/record/request`. `call_id` is unused.
		callSid: params.pbx_call_id ?? "",
		recordingSid: params.call_id_with_rec ?? "",
		recordingStatus: "completed",
	};
}

/**
 * Shape of `pbx_call_id`, and the ONLY thing standing between one captured
 * webhook and a fistful of forged `call_sid` values.
 *
 * Zadarma signs the CONCATENATION of the event's fields with nothing between
 * them (`zadarma-signature.ts` documents the measurement), so a single valid
 * signature validates every SPLIT of the same string — and `pbx_call_id` becomes
 * `callSid`, the anchor of `conv_user_callsid_uq`, which that same file names as
 * a security control. Requiring an EXACT length here is what collapses the
 * ambiguity: with `pbx_call_id` pinned to `in_`/`out_` + exactly 40 hex chars the
 * split point is determined, so no alternative split can validate — and it stays
 * determined WITHOUT pinning `call_id_with_rec`, whose format we have never
 * observed (it did not appear in any of the spike's `--find` runs).
 *
 * MEASURED end to end, one full sample per direction, both exactly 40 hex:
 *   in_20b67427cf29e305a77f09d12a3976e092787adf   (inbound, 2026-09-05 16:36)
 *   out_d0b9c44cd60506e90d85f31ea088089d9c3ef0cc  (outbound, 2026-09-05 22:25)
 *
 * The outbound one was pulled specifically because impl-review F2 caught this
 * comment claiming two measurements when the trail only held one — the `out_`
 * sample in the spike notes is truncated with an ellipsis and its length had
 * never actually been read. Do not re-weaken that: `out_` is the branch every
 * click-to-call recording arrives on.
 *
 * ⚠️ STILL NOT A SPEC — one sample per direction, from one account, and the
 * vendor documents neither the prefix nor the length. If Zadarma ever changes
 * the id length this refuses a REAL recording, and the symptom is a 403: the
 * same symptom as a wrong HMAC recipe, which is exactly what the plan's "no 403
 * in `fly logs`" criterion watches for. That is why a refusal here emits
 * `telephony.zadarma.malformed_id` with a REDACTED shape summary — read that
 * line before suspecting the signature recipe.
 *
 * WHY IT LIVES IN THIS FILE and not next to its first caller. The SAME predicate
 * now validates ids arriving by two independent routes: `pbx_call_id` on a
 * webhook (`zadarma.ts` `verifySignature`) and `pbx_call_id` read back out of
 * `/v1/statistics/pbx/` (`zadarma-statistics.ts`, capture reconciliation). Both
 * become `conversations.call_sid`, so both are the security control described
 * above — and the statistics mapper is bound by `telephony-params-are-pure` to
 * import nothing but this file and `types.ts`, so it could not reach a copy kept
 * in `zadarma.ts` anyway. TWO copies of this regex is the failure mode: one gets
 * tightened, the other does not, and the looser route becomes the way in.
 * `zadarma.ts` already imported `isZadarmaRecordingEvent` from here, so this is
 * the existing precedent (vendor client imports the pure leaf), not a new shape.
 */
export const PBX_CALL_ID_SHAPE = /^(?:in|out)_[0-9a-f]{40}$/;
