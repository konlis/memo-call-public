import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import { MockTelephonyProvider } from "~/server/telephony/mock";

describe("MockTelephonyProvider", () => {
	const tel = new MockTelephonyProvider();

	it("always accepts the signature (no real HMAC in mock mode)", () => {
		expect(
			tel.verifySignature({ signature: "anything", url: "x", params: {} }),
		).toBe(true);
	});

	it("builds dual-channel record TwiML pointing at the callback url", () => {
		const { body, contentType } = tel.buildInboundResponse({
			recordingStatusCallbackUrl: "https://your-app.fly.dev/api/telephony/rec",
		});
		// Content assertions UNCHANGED across the rename — they are the
		// characterization test proving this phase moved the wrapper, not the bytes.
		expect(body).toContain('record="record-from-answer-dual"');
		expect(body).toContain("<Number>");
		expect(body).toContain(
			'recordingStatusCallback="https://your-app.fly.dev/api/telephony/rec"',
		);
		expect(contentType).toBe("text/xml");
	});

	it("maps Twilio-shaped callback params onto a vendor-neutral event", () => {
		const event = tel.parseRecordingEvent({
			CallSid: "CA123",
			RecordingSid: "RE456",
			RecordingStatus: "Completed",
			RecordingDuration: "42",
			RecordingStartTime: "Fri, 13 Feb 2026 20:30:00 +0000",
			From: "+48111222333",
			To: "+48999888777",
		});
		expect(event).toMatchObject({
			callSid: "CA123",
			recordingSid: "RE456",
			recordingStatus: "completed",
			recordingDurationMs: 42000,
			from: "+48111222333",
			to: "+48999888777",
		});
		// FR-007: RecordingStartTime → startedAt; endedAt derived (start + duration).
		expect(event.startedAt?.toISOString()).toBe("2026-02-13T20:30:00.000Z");
		expect(event.endedAt?.toISOString()).toBe("2026-02-13T20:30:42.000Z");
	});

	it("leaves startedAt/endedAt undefined when RecordingStartTime is absent", () => {
		const event = tel.parseRecordingEvent({
			CallSid: "CA123",
			RecordingSid: "RE456",
			RecordingStatus: "completed",
			RecordingDuration: "42",
		});
		expect(event.startedAt).toBeUndefined();
		expect(event.endedAt).toBeUndefined();
	});

	it("streamRecording resolves without writing bytes", async () => {
		let wrote = 0;
		const sink = new WritableStream<Uint8Array>({
			write() {
				wrote += 1;
			},
		});
		await expect(
			tel.streamRecording({ recordingSid: "RE456" }, sink),
		).resolves.toBeUndefined();
		expect(wrote).toBe(0);
	});

	it("deleteRecording is a resolving no-op", async () => {
		await expect(
			tel.deleteRecording({ recordingSid: "RE456" }),
		).resolves.toBeUndefined();
	});

	it("placeCall returns a mock-shaped callSid (no network)", async () => {
		const result = await tel.placeCall({
			to: "+48600100200",
			recordingStatusCallbackUrl: "https://your-app.fly.dev/api/telephony/rec",
		});
		expect(result.callSid).toMatch(/^mock-call-/);
	});

	describe("with MOCK_TELEPHONY_FORCE_ERROR=transport", () => {
		const original = process.env.MOCK_TELEPHONY_FORCE_ERROR;
		beforeEach(() => {
			process.env.MOCK_TELEPHONY_FORCE_ERROR = "transport";
		});
		afterEach(() => {
			if (original === undefined) {
				delete process.env.MOCK_TELEPHONY_FORCE_ERROR;
			} else {
				process.env.MOCK_TELEPHONY_FORCE_ERROR = original;
			}
		});

		it("streamRecording throws ProviderError(transport)", async () => {
			const sink = new WritableStream<Uint8Array>({ write() {} });
			const promise = tel.streamRecording({ recordingSid: "RE456" }, sink);
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "transport" });
		});

		it("deleteRecording throws ProviderError(transport)", async () => {
			const promise = tel.deleteRecording({ recordingSid: "RE456" });
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "transport" });
		});

		it("placeCall throws ProviderError(transport)", async () => {
			const promise = tel.placeCall({
				to: "+48600100200",
				recordingStatusCallbackUrl:
					"https://your-app.fly.dev/api/telephony/rec",
			});
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "transport" });
		});
	});

	describe("with MOCK_TELEPHONY_FORCE_ERROR set to a typo (invalid value)", () => {
		const original = process.env.MOCK_TELEPHONY_FORCE_ERROR;
		beforeEach(() => {
			process.env.MOCK_TELEPHONY_FORCE_ERROR = "transprt";
		});
		afterEach(() => {
			if (original === undefined) {
				delete process.env.MOCK_TELEPHONY_FORCE_ERROR;
			} else {
				process.env.MOCK_TELEPHONY_FORCE_ERROR = original;
			}
		});

		it("throws ProviderError(unknown) — fail-loud, not silent fallthrough", async () => {
			const promise = tel.deleteRecording({ recordingSid: "RE456" });
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "unknown" });
		});
	});
});
