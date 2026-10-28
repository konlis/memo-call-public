import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import { TwilioTelephonyProvider } from "~/server/telephony/twilio";

// A syntactically-valid Twilio account SID (starts with "AC") + arbitrary token.
// No network is touched: only verifySignature (pure HMAC) and buildInboundResponse
// (pure TwiML) are exercised here.
const AUTH_TOKEN = "test_auth_token_0123456789abcdef";
const config = {
	accountSid: "AC00000000000000000000000000000000",
	authToken: AUTH_TOKEN,
	forwardNumber: "+48XXXXXXXXX",
};
const CALLER_ID = "+48732999000";
const outboundConfig = { ...config, callerId: CALLER_ID };

/**
 * Twilio's documented signature algorithm: take the full URL, append each POST
 * param's key+value in alphabetical key order, HMAC-SHA1 with the auth token,
 * base64-encode. Used here to mint a genuinely-valid signature so we exercise
 * the accept path of the wrapped `validateRequest`.
 */
function twilioSignature(
	authToken: string,
	url: string,
	params: Record<string, string>,
): string {
	const data = Object.keys(params)
		.sort()
		.reduce((acc, key) => acc + key + params[key], url);
	return crypto
		.createHmac("sha1", authToken)
		.update(Buffer.from(data, "utf-8"))
		.digest("base64");
}

describe("TwilioTelephonyProvider — construction", () => {
	it("throws ProviderError(auth) when required env is missing", () => {
		expect(() => new TwilioTelephonyProvider({})).toThrow(ProviderError);
		try {
			new TwilioTelephonyProvider({});
		} catch (e) {
			expect(e).toMatchObject({ code: "auth" });
		}
	});

	it("throws ProviderError(auth) when only the forward number is missing", () => {
		expect(
			() =>
				new TwilioTelephonyProvider({
					accountSid: config.accountSid,
					authToken: config.authToken,
				}),
		).toThrow(ProviderError);
	});

	it("constructs when all required values are present", () => {
		expect(() => new TwilioTelephonyProvider(config)).not.toThrow();
	});

	it("constructs WITHOUT callerId — outbound credential, inbound boot unaffected (F1)", () => {
		// callerId is outbound-only; its absence must NOT crash construction, or
		// the live inbound path would fail to boot whenever the secret is unset.
		expect(() => new TwilioTelephonyProvider(config)).not.toThrow();
	});
});

describe("TwilioTelephonyProvider — verifySignature", () => {
	const tel = new TwilioTelephonyProvider(config);
	const url = "https://your-app.fly.dev/api/telephony/recording-status";
	const params = {
		CallSid: "CA1",
		RecordingSid: "RE1",
		RecordingStatus: "completed",
	};

	it("accepts a correctly-computed Twilio signature", () => {
		const signature = twilioSignature(AUTH_TOKEN, url, params);
		expect(tel.verifySignature({ signature, url, params })).toBe(true);
	});

	it("rejects a tampered signature", () => {
		expect(tel.verifySignature({ signature: "deadbeef", url, params })).toBe(
			false,
		);
	});

	it("rejects when the params differ from what was signed", () => {
		const signature = twilioSignature(AUTH_TOKEN, url, params);
		expect(
			tel.verifySignature({
				signature,
				url,
				params: { ...params, RecordingStatus: "failed" },
			}),
		).toBe(false);
	});

	// `url` is optional on the shared WebhookSignatureInput because not every
	// provider signs the URL. Twilio does, so a URL it cannot parse is a
	// signature it cannot check — and the signature is the ONLY authorization a
	// webhook has. Without the explicit guard this does not merely fail-open, it
	// THROWS: the SDK's first statement is `new URL(url)`, so absent, empty and
	// malformed all raise TypeError, which would surface as a 500 rather than a
	// clean refusal. Both assertions matter in each case: no throw AND a false.
	it("refuses (fail-closed, no throw) when url is absent", () => {
		const signature = twilioSignature(AUTH_TOKEN, url, params);
		expect(() => tel.verifySignature({ signature, params })).not.toThrow();
		expect(tel.verifySignature({ signature, params })).toBe(false);
	});

	it("refuses (fail-closed, no throw) when url is an empty string", () => {
		const signature = twilioSignature(AUTH_TOKEN, url, params);
		expect(() =>
			tel.verifySignature({ signature, url: "", params }),
		).not.toThrow();
		expect(tel.verifySignature({ signature, url: "", params })).toBe(false);
	});

	// A non-empty but unparseable url is the case a truthiness-only guard misses:
	// it passes `!input.url` and then throws inside the SDK. A relative path is
	// the realistic shape (a caller reconstructing from a request pathname while
	// PUBLIC_BASE_URL is unset), which is why it is asserted alongside garbage.
	it.each([
		"not-a-url",
		"/api/telephony/recording-status",
	])("refuses (fail-closed, no throw) when url is unparseable: %s", (badUrl) => {
		const signature = twilioSignature(AUTH_TOKEN, url, params);
		expect(() =>
			tel.verifySignature({ signature, url: badUrl, params }),
		).not.toThrow();
		expect(tel.verifySignature({ signature, url: badUrl, params })).toBe(false);
	});
});

describe("TwilioTelephonyProvider — buildInboundResponse", () => {
	const tel = new TwilioTelephonyProvider(config);

	it("matches the spike's record-from-answer-dual + Number shape", () => {
		const { body, contentType } = tel.buildInboundResponse({
			recordingStatusCallbackUrl:
				"https://your-app.fly.dev/api/telephony/recording-status",
		});
		// Content assertions UNCHANGED across the rename — they are the
		// characterization test proving this phase moved the wrapper, not the bytes.
		expect(body).toContain("<Response>");
		expect(body).toContain('record="record-from-answer-dual"');
		expect(body).toContain(`<Number>${config.forwardNumber}</Number>`);
		expect(body).toContain(
			'recordingStatusCallback="https://your-app.fly.dev/api/telephony/recording-status"',
		);
		expect(contentType).toBe("text/xml");
	});
});

/** A real `Response` whose body streams the given chunks then closes. */
function streamResponse(chunks: Uint8Array[], status = 200): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(body, { status });
}

/** A real `Response` whose body errors mid-read (simulates a network drop). */
function erroringResponse(status = 200): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("network drop"));
		},
	});
	return new Response(body, { status });
}

/** Collect everything written to a WritableStream for assertions. */
function collectingSink(into: Uint8Array[]): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			into.push(chunk);
		},
	});
}

describe("TwilioTelephonyProvider — streamRecording / deleteRecording (stubbed fetch)", () => {
	const tel = new TwilioTelephonyProvider(config);

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("streams the recording bytes into the sink (happy path)", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(streamResponse([new Uint8Array([1, 2, 3, 4])]));
		vi.stubGlobal("fetch", fetchMock);

		const collected: Uint8Array[] = [];
		await tel.streamRecording(
			{ recordingSid: "RE1" },
			collectingSink(collected),
		);

		expect(collected.flatMap((c) => [...c])).toEqual([1, 2, 3, 4]);
		// Authenticated GET against the recording media URL.
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toContain("/Recordings/RE1.wav");
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^Basic /,
		);
	});

	/**
	 * FU-1 (review of phase 2, F2). `recordingContentType` and the extension in
	 * the media URL were two independent literals coupled only by a comment. They
	 * are one `RECORDING_MEDIA` value now, but the class keeps them private, so
	 * this asserts the coupling through the only two surfaces a consumer sees:
	 * the declared MIME, and the URL actually fetched.
	 *
	 * It matters because the mismatch is invisible everywhere else. `worker.ts`
	 * forwards `recordingContentType` verbatim as the Content-Type of the upload
	 * to Deepgram, so fetching one format while announcing another mislabels the
	 * STT request — and an extension is a URL segment while a MIME is a string,
	 * so no type and no other test relates them.
	 */
	it("declares the same format it fetches [FU-1]", async () => {
		// Deliberately an INDEPENDENT table, not an import of the provider's own
		// constant: a check that re-uses the value under test proves nothing.
		const EXTENSION_FOR: Record<string, string> = {
			"audio/wav": "wav",
			"audio/mpeg": "mp3",
			"audio/ogg": "ogg",
			"audio/x-wav": "wav",
		};

		const fetchMock = vi
			.fn()
			.mockResolvedValue(streamResponse([new Uint8Array([1])]));
		vi.stubGlobal("fetch", fetchMock);
		await tel.streamRecording({ recordingSid: "RE1" }, collectingSink([]));

		const declared = tel.recordingContentType;
		const expectedExt = EXTENSION_FOR[declared];
		// An unmapped MIME fails loudly rather than passing vacuously — the trap of
		// every lookup-driven assertion.
		expect(
			expectedExt,
			`recordingContentType "${declared}" is not in this test's MIME table; add it (and confirm the STT provider accepts the format) rather than deleting the check`,
		).toBeDefined();

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(String(url).endsWith(`.${expectedExt}`)).toBe(true);
	});

	it("remaps a mid-stream drop to ProviderError(transport) [F1]", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(erroringResponse(200)));
		const promise = tel.streamRecording(
			{ recordingSid: "RE1" },
			collectingSink([]),
		);
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});

	it("maps a 403 media response to ProviderError(auth)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);
		const promise = tel.streamRecording(
			{ recordingSid: "RE1" },
			collectingSink([]),
		);
		await expect(promise).rejects.toMatchObject({ code: "auth" });
	});

	it("maps a 500 media response to ProviderError(transport)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
		);
		const promise = tel.streamRecording(
			{ recordingSid: "RE1" },
			collectingSink([]),
		);
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});

	it("maps a missing media body to ProviderError(invalid_response)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		);
		const promise = tel.streamRecording(
			{ recordingSid: "RE1" },
			collectingSink([]),
		);
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps a fetch network throw to ProviderError(transport)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		);
		const promise = tel.streamRecording(
			{ recordingSid: "RE1" },
			collectingSink([]),
		);
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});

	it("treats DELETE 404 as idempotent success (FR-002)", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			tel.deleteRecording({ recordingSid: "RE1" }),
		).resolves.toBeUndefined();
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toContain("/Recordings/RE1.json");
		expect(init.method).toBe("DELETE");
	});

	it("maps a DELETE 500 to ProviderError(transport)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
		);
		const promise = tel.deleteRecording({ recordingSid: "RE1" });
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});
});

describe("TwilioTelephonyProvider — placeCall (outbound click-to-call, stubbed fetch)", () => {
	const tel = new TwilioTelephonyProvider(outboundConfig);
	const callbackUrl = "https://your-app.fly.dev/api/telephony/recording-status";
	const recipient = "+48600100200";

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POSTs to Calls.json with To=forwardNumber, From=callerId, and bridge Twiml", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ sid: "CA_outbound_1" }), { status: 201 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		expect(result).toEqual({ callSid: "CA_outbound_1" });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		// REST endpoint + method.
		expect(url).toContain("/Calls.json");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^Basic /,
		);
		// Form body: To = the user's own GSM (rung first), From = the DID.
		const body = init.body as URLSearchParams;
		expect(body.get("To")).toBe(config.forwardNumber);
		expect(body.get("From")).toBe(CALLER_ID);
		// Inline bridge TwiML dials the RECIPIENT + records dual-channel + callback.
		const twiml = body.get("Twiml") ?? "";
		expect(twiml).toContain('record="record-from-answer-dual"');
		expect(twiml).toContain(`<Number>${recipient}</Number>`);
		expect(twiml).toContain(`recordingStatusCallback="${callbackUrl}"`);
	});

	it("maps a 401 Calls.json response to ProviderError(auth)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
		);
		const promise = tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "auth" });
	});

	it("maps a 500 Calls.json response to ProviderError(transport)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
		);
		const promise = tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});

	it("maps a fetch network throw to ProviderError(transport)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		);
		const promise = tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});

	it("throws ProviderError(invalid_response) when the JSON has no sid", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify({}), { status: 201 })),
		);
		const promise = tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("throws ProviderError(auth) and makes NO REST call when callerId is unset (F1 lazy validation)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		// Construct WITHOUT callerId (inbound config) — construction itself succeeds.
		const inboundOnly = new TwilioTelephonyProvider(config);
		const promise = inboundOnly.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "auth" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
