import { describe, expect, test, vi } from "vitest";

// The voice-webhook twin of `recording-status/route.test.ts` (Phase 6 of
// `refactor-opportunities`, K-12 / gap N-1). This handler answers the inbound
// call — if its wiring is wrong there is no recording to process at all. Only
// `~/server/telephony` needs mocking here: this route touches neither the db nor
// the worker, and its `~/server/telephony/webhooks` import is a pure module.
// `vi.hoisted` — see the note in recording-status/route.test.ts. Import-time
// cleanliness is pinned separately by `import-clean.test.ts`.
const { telephonyStub } = vi.hoisted(() => ({
	telephonyStub: {
		// Kept in step with the real provider even though this file mocks the
		// handler (so nothing reads it here): a vi.mock factory's return is NOT
		// type-checked against the module's exports, so a widened interface
		// never reaches these stubs as a compile error.
		signatureHeader: "x-twilio-signature",
		verifySignature: vi.fn(),
		buildInboundResponse: vi.fn(),
	},
}));

vi.mock("~/server/telephony", () => ({ telephony: telephonyStub }));
vi.mock("~/server/telephony/webhooks", () => ({
	handleVoiceWebhook: vi.fn(
		async () => new Response("<Response/>", { status: 200 }),
	),
	handleRecordingStatus: vi.fn(),
}));

import { env } from "~/env";
import { handleVoiceWebhook } from "~/server/telephony/webhooks";
import { POST } from "./route";

function makeRequest(): Request {
	return new Request("https://your-app.fly.dev/api/telephony/voice", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-twilio-signature": "sig",
		},
		body: new URLSearchParams({ CallSid: "CA123" }).toString(),
	});
}

const handlerMock = vi.mocked(handleVoiceWebhook);

describe("POST /api/telephony/voice — dependency wiring", () => {
	test("passes the request through and returns the handler's response verbatim", async () => {
		const request = makeRequest();

		const response = await POST(request);

		expect(handlerMock).toHaveBeenCalledTimes(1);
		expect(handlerMock.mock.calls[0]?.[0]).toBe(request);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<Response/>");
	});

	test("wires the telephony singleton and the env base URL", async () => {
		handlerMock.mockClear();

		await POST(makeRequest());

		const deps = handlerMock.mock.calls[0]?.[1];
		expect(deps?.telephony).toBe(telephonyStub);
		// Both the signature check and the recording-status callback URL the TwiML
		// carries are built from this — a wrong value breaks the whole ingress.
		expect(deps?.publicBaseUrl).toBe(env.PUBLIC_BASE_URL);
	});
});
