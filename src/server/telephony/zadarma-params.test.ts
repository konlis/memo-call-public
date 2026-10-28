import { describe, expect, it } from "vitest";

import { parseZadarmaRecordingEvent } from "~/server/telephony/zadarma-params";

/**
 * The seven event types Zadarma pushes to the same account-level notification
 * URL that are NOT a finished recording. The whole reason they are listed here
 * is the assertion below: none of them may produce `"completed"`, because that
 * is the ONLY thing keeping `webhooks.ts` from processing them.
 */
const NON_RECORDING_EVENTS = [
	"NOTIFY_START",
	"NOTIFY_INTERNAL",
	"NOTIFY_ANSWER",
	"NOTIFY_END",
	"NOTIFY_OUT_START",
	"NOTIFY_OUT_END",
	"NOTIFY_IVR",
] as const;

describe("parseZadarmaRecordingEvent", () => {
	it("maps NOTIFY_RECORD onto a completed event carrying both identifiers", () => {
		const event = parseZadarmaRecordingEvent({
			event: "NOTIFY_RECORD",
			pbx_call_id: "in_68ba1f0e5c",
			call_id_with_rec: "1757079412.123456",
		});
		expect(event).toEqual({
			callSid: "in_68ba1f0e5c",
			recordingSid: "1757079412.123456",
			// Synthesized: Zadarma has no status field — the event IS the completion.
			recordingStatus: "completed",
		});
		// NOTIFY_RECORD carries only three fields; timing lives in NOTIFY_END.
		expect(event.from).toBeUndefined();
		expect(event.to).toBeUndefined();
		expect(event.recordingDurationMs).toBeUndefined();
		expect(event.startedAt).toBeUndefined();
		expect(event.endedAt).toBeUndefined();
	});

	it.each(
		NON_RECORDING_EVENTS,
	)("maps %s onto a non-terminal status with empty identifiers", (name) => {
		const event = parseZadarmaRecordingEvent({
			event: name,
			pbx_call_id: "in_68ba1f0e5c",
			// Present on purpose: even if the vendor ever attached it to another
			// event, only NOTIFY_RECORD may be allowed through.
			call_id_with_rec: "1757079412.123456",
		});
		expect(event.recordingStatus).not.toBe("completed");
		expect(event.recordingStatus).toBe(name.toLowerCase());
		expect(event.callSid).toBe("");
		expect(event.recordingSid).toBe("");
	});

	it("treats a missing event field as a no-op rather than a recording", () => {
		const event = parseZadarmaRecordingEvent({ pbx_call_id: "in_abc" });
		expect(event.recordingStatus).toBe("");
		expect(event.recordingStatus).not.toBe("completed");
		expect(event.callSid).toBe("");
	});

	it("accepts the event name case-insensitively", () => {
		const event = parseZadarmaRecordingEvent({
			event: "notify_record",
			pbx_call_id: "in_abc",
			call_id_with_rec: "rec_1",
		});
		expect(event.recordingStatus).toBe("completed");
		expect(event.callSid).toBe("in_abc");
	});

	// The lowercase-passthrough can ALIAS onto the reserved terminal value: an
	// event literally named "Completed" takes the non-record branch and still
	// yields recordingStatus "completed". Two downstream guards stop it doing harm
	// today (verifySignature refuses any non-NOTIFY_RECORD event, and webhooks.ts
	// no-ops on a blank call_sid), but nothing here enforced the invariant — so if
	// either guard is ever removed this becomes reachable silently. Pin it.
	it("only NOTIFY_RECORD may yield the terminal status, whatever the name", () => {
		for (const name of ["Completed", "COMPLETED", "completed"]) {
			const event = parseZadarmaRecordingEvent({
				event: name,
				pbx_call_id: "in_abc",
				call_id_with_rec: "rec_1",
			});
			// The alias is reachable...
			expect(event.recordingStatus).toBe("completed");
			// ...but it can never carry the identifiers that would let it act.
			expect(event.callSid).toBe("");
			expect(event.recordingSid).toBe("");
		}
	});

	it("yields empty identifiers when NOTIFY_RECORD arrives without them", () => {
		const event = parseZadarmaRecordingEvent({ event: "NOTIFY_RECORD" });
		expect(event).toEqual({
			callSid: "",
			recordingSid: "",
			recordingStatus: "completed",
		});
	});
});
