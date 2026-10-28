/**
 * Twilio recording-status form-field mapping. VENDOR FILE — the only place in
 * the repo that knows Twilio's form-field names.
 *
 * Deliberately its own module rather than part of `twilio.ts`: `mock.ts` reuses
 * this mapping so dev/CI parse callbacks identically to production, and
 * `twilio.ts` opens with `import twilio from "twilio"` — folding this in would
 * drag the vendor SDK into the mock, which exists precisely to run without it.
 * Same split as `auth/password-rules.ts` out of `auth/password.ts` (F-03).
 *
 * Imports NOTHING but the `RecordingEvent` type. The
 * `telephony-mock-no-vendor-sdk` rule in `.dependency-cruiser.cjs` turns a
 * regression here into a build error rather than a puzzle.
 */

import type { RecordingEvent } from "~/server/telephony/types";

/**
 * Map raw Twilio recording-status form params onto the vendor-neutral
 * `RecordingEvent`. Shared by the real + mock providers so the field mapping
 * (incl. the FR-007 `started_at`/`ended_at` derivation) lives in one place.
 *
 * Twilio sends `RecordingStartTime` as an RFC-2822 string and carries NO explicit
 * end time, so `endedAt` is derived (start + duration). An absent/unparseable
 * start leaves `startedAt`/`endedAt` undefined — both columns are nullable.
 */
export function parseRecordingEventParams(
	params: Record<string, string>,
): RecordingEvent {
	const durationSec = Number(params.RecordingDuration);
	const recordingDurationMs = Number.isFinite(durationSec)
		? durationSec * 1000
		: undefined;
	const startMs = Date.parse(params.RecordingStartTime ?? "");
	const startedAt = Number.isNaN(startMs) ? undefined : new Date(startMs);
	const endedAt =
		startedAt && recordingDurationMs !== undefined
			? new Date(startedAt.getTime() + recordingDurationMs)
			: undefined;
	return {
		callSid: params.CallSid ?? "",
		recordingSid: params.RecordingSid ?? "",
		recordingStatus: (params.RecordingStatus ?? "").toLowerCase(),
		from: params.From,
		to: params.To,
		recordingDurationMs,
		startedAt,
		endedAt,
	};
}
