import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ProviderError } from "~/server/_lib/provider-error";
// Vendor field-mapping only — `twilio-params.ts` imports nothing but a type, so
// this does NOT drag `import twilio from "twilio"` into the mock. Enforced by
// the `telephony-mock-no-vendor-sdk` rule in `.dependency-cruiser.cjs`.
import { parseRecordingEventParams } from "~/server/telephony/twilio-params";
import type {
	RecordingEvent,
	TelephonyProvider,
	WebhookSignatureInput,
} from "~/server/telephony/types";

// Direct process.env read (NOT through ~/env) — same rationale as the STT/LLM
// mocks: @t3-oss/env-nextjs caches the parsed env at module import, so tests
// mutating process.env.MOCK_TELEPHONY_FORCE_ERROR mid-run would be invisible if
// we read it through `env`. The env.js entry exists for build-time validation.
const forceErrorSchema = z
	.enum(["transport", "rate_limited", "auth", "invalid_response"])
	.optional();

function forcedError(): ProviderError | null {
	const parsed = forceErrorSchema.safeParse(
		process.env.MOCK_TELEPHONY_FORCE_ERROR,
	);
	if (!parsed.success) {
		return new ProviderError({
			code: "unknown",
			message: "invalid MOCK_TELEPHONY_FORCE_ERROR value",
		});
	}
	if (parsed.data) {
		return new ProviderError({
			code: parsed.data,
			message: "forced via MOCK_TELEPHONY_FORCE_ERROR",
		});
	}
	return null;
}

/** Placeholder GSM the mock "forwards" to — never dialed (no real Twilio leg). */
const MOCK_FORWARD_NUMBER = "+10000000000";

/**
 * Deterministic provider so the full pipeline runs in CI/dev without Twilio.
 * Signature is always valid; `streamRecording` writes no bytes (the worker
 * resolves the STT input to `mock://` by provider mode, not from this call);
 * `deleteRecording` is a no-op. `MOCK_TELEPHONY_FORCE_ERROR` drives error paths.
 */
export class MockTelephonyProvider implements TelephonyProvider {
	// Deliberately the SAME values as the real provider — dev/CI must be
	// structurally identical to production on these two, exactly as the mock
	// already mirrors the real TwiML shape below. A mock that declared a
	// different header or MIME type would let a consumer that reads them wrongly
	// still pass the whole suite.
	readonly signatureHeader = "x-twilio-signature";
	readonly recordingContentType = "audio/wav";

	verifySignature(_input: WebhookSignatureInput): boolean {
		return true;
	}

	buildInboundResponse(input: { recordingStatusCallbackUrl: string }): {
		body: string;
		contentType: string;
	} {
		// Mirror the real provider's shape (record-from-answer-dual + Number) so
		// dev/CI output is structurally identical to production TwiML.
		const body =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			"<Response>" +
			`<Dial record="record-from-answer-dual" recordingStatusCallback="${input.recordingStatusCallbackUrl}" recordingStatusCallbackEvent="completed">` +
			`<Number>${MOCK_FORWARD_NUMBER}</Number>` +
			"</Dial>" +
			"</Response>";
		return { body, contentType: "text/xml" };
	}

	parseRecordingEvent(params: Record<string, string>): RecordingEvent {
		return parseRecordingEventParams(params);
	}

	async placeCall(_input: {
		to: string;
		recordingStatusCallbackUrl: string;
	}): Promise<{ callSid: string }> {
		const err = forcedError();
		if (err) throw err;
		// Deterministic-shape sid (no network); lets the mutation + UI run in
		// dev/CI without Twilio.
		return { callSid: `mock-call-${randomUUID()}` };
	}

	async streamRecording(
		_input: { recordingSid: string },
		_sink: WritableStream<Uint8Array>,
	): Promise<void> {
		const err = forcedError();
		if (err) throw err;
		// No bytes: the worker drains this in mock mode purely to prove the
		// authenticated-pull call path, then transcribes `mock://long`.
	}

	async deleteRecording(_input: { recordingSid: string }): Promise<void> {
		const err = forcedError();
		if (err) throw err;
	}
}
