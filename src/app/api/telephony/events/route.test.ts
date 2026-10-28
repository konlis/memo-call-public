import { describe, expect, test, vi } from "vitest";

// Wiring test for the single account-level notification endpoint. Same shape and
// same constraints as `../recording-status/route.test.ts` next door — read its
// header for why the mocks are hoisted and why the assertions are deliberately
// narrow (composition only; handler BEHAVIOR lives in `webhooks.test.ts` and
// `webhooks.integration.test.ts`).
const { dbStub, telephonyStub } = vi.hoisted(() => ({
	dbStub: { transaction: vi.fn() },
	telephonyStub: {
		signatureHeader: "signature",
		verifySignature: vi.fn(),
		parseRecordingEvent: vi.fn(),
		handleChallenge: vi.fn(),
	},
}));

vi.mock("~/server/db", () => ({ db: dbStub, client: {} }));
vi.mock("~/server/telephony", () => ({ telephony: telephonyStub }));
vi.mock("~/server/telephony/webhooks", () => ({
	handleChallenge: vi.fn(() => new Response("challenged", { status: 200 })),
	handleRecordingStatus: vi.fn(
		async () => new Response("stubbed", { status: 200 }),
	),
	handleVoiceWebhook: vi.fn(),
}));

import { handleChallenge } from "~/server/telephony/webhooks";
import { POST as recordingStatusPost } from "../recording-status/route";
import { GET, POST } from "./route";

const challengeMock = vi.mocked(handleChallenge);

describe("GET /api/telephony/events — handshake wiring", () => {
	test("hands the request to handleChallenge with the telephony singleton", async () => {
		challengeMock.mockClear();

		const request = new Request(
			"https://your-app.fly.dev/api/telephony/events?zd_echo=abc123",
		);
		const response = await GET(request);

		expect(challengeMock).toHaveBeenCalledTimes(1);
		expect(challengeMock.mock.calls[0]?.[0]).toBe(request);
		// The lazily-imported singleton reaches the handler, not a fresh instance.
		expect(challengeMock.mock.calls[0]?.[1]?.telephony).toBe(telephonyStub);
		// Returned verbatim — the route adds nothing to the echo.
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("challenged");
	});
});

describe("POST /api/telephony/events — job ingress", () => {
	// The point of the re-export: not "the same code" but the same FUNCTION, so
	// the two ingresses cannot drift in which deps they wire. A copy-paste
	// re-implementation would still pass a behavioral test and fail this one.
	test("is the very same handler as /api/telephony/recording-status", () => {
		expect(POST).toBe(recordingStatusPost);
	});
});
