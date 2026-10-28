import { describe, expect, test, vi } from "vitest";

// The first test of the product's ingress (Phase 6 of `refactor-opportunities`,
// K-12 / gap N-1). Every note enters through this route handler, and it had zero
// tests — not for lack of value but because the module was UNIMPORTABLE: its
// static imports opened a libsql connection (`db/index.ts` top-level `await
// PRAGMA`) and constructed the telephony provider. The handler resolves them
// lazily now, so the module imports clean.
//
// THREE mocks, not one. The lazy import moved the side effect from import time to
// CALL time — invoking `POST` still executes `await import("~/server/db")` and
// `await import("~/server/jobs/worker")` (which statically pulls the same db
// singleton). Vitest intercepts dynamic `import()` through the same module
// registry as static imports, so mocking all three keeps the real connection and
// the real provider out of the test.
//
// The assertion is therefore deliberately NARROW: this proves COMPOSITION — which
// deps this route wires into the handler — and nothing about handler behavior,
// which already has `webhooks.test.ts` + `webhooks.integration.test.ts`. That
// narrow slice IS the N-1 gap.
// `vi.hoisted` so the stubs exist before the hoisted `vi.mock` factories can run.
// Without it these are plain consts declared BELOW the factories, and the file
// only works because the mocked modules happen to be imported lazily (at call
// time); a reintroduced static import would fail with a TDZ
// `Cannot access 'dbStub' before initialization` instead of a real assertion.
// The property that regression actually breaks is pinned by `import-clean.test.ts`.
const { dbStub, telephonyStub } = vi.hoisted(() => ({
	dbStub: { transaction: vi.fn() },
	telephonyStub: {
		// See the twin note in voice/route.test.ts: a vi.mock factory escapes
		// type-checking, so an interface widening never surfaces here as an
		// error. Kept in step with the real provider by hand.
		signatureHeader: "x-twilio-signature",
		verifySignature: vi.fn(),
		parseRecordingEvent: vi.fn(),
	},
}));

vi.mock("~/server/db", () => ({ db: dbStub, client: {} }));
vi.mock("~/server/telephony", () => ({ telephony: telephonyStub }));
vi.mock("~/server/telephony/webhooks", () => ({
	handleRecordingStatus: vi.fn(
		async () => new Response("stubbed", { status: 200 }),
	),
	handleVoiceWebhook: vi.fn(),
}));

import { env } from "~/env";
import { handleRecordingStatus } from "~/server/telephony/webhooks";
import { POST } from "./route";

function makeRequest(body: Record<string, string> = {}): Request {
	return new Request(
		"https://your-app.fly.dev/api/telephony/recording-status",
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-twilio-signature": "sig",
			},
			body: new URLSearchParams(body).toString(),
		},
	);
}

const handlerMock = vi.mocked(handleRecordingStatus);

describe("POST /api/telephony/recording-status — dependency wiring", () => {
	test("passes the request through and returns the handler's response verbatim", async () => {
		const request = makeRequest({
			CallSid: "CA123",
			RecordingSid: "RE123",
			RecordingStatus: "completed",
		});

		const response = await POST(request);

		expect(handlerMock).toHaveBeenCalledTimes(1);
		expect(handlerMock.mock.calls[0]?.[0]).toBe(request);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("stubbed");
	});

	test("wires the single-user constant, the env base URL, the db and telephony singletons, and a callable kickoff", async () => {
		handlerMock.mockClear();

		await POST(makeRequest());

		const deps = handlerMock.mock.calls[0]?.[1];
		// `userId` is hardcoded, NOT resolved from a session — Twilio is
		// unauthenticated, the signature is the auth (CLAUDE.md single-user rule).
		expect(deps?.userId).toBe("me");
		// The signed-URL check depends on this being the PUBLIC origin from env, not
		// a request header — a wrong value here silently 403s every real webhook.
		expect(deps?.publicBaseUrl).toBe(env.PUBLIC_BASE_URL);
		// The lazily-imported singletons reach the handler (not a fresh instance).
		expect(deps?.db).toBe(dbStub);
		expect(deps?.telephony).toBe(telephonyStub);
		// The Phase 4 fast-path is wired. Only its presence/shape is asserted —
		// invoking it would start the worker against a stub db.
		expect(typeof deps?.kickoff).toBe("function");
	});
});
