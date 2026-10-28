import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import type { TelephonyProvider } from "~/server/telephony/types";
import { ZadarmaTelephonyProvider } from "~/server/telephony/zadarma";

/**
 * Provider-level tests for the Zadarma capture provider. Mirror of
 * `twilio.test.ts`: nothing here touches the network — `fetch` is stubbed and the
 * only real cryptography is the webhook MAC, minted here from the documented
 * recipe so the accept path is exercised for real rather than asserted about.
 */

const SECRET = "test-zadarma-secret";
const config = {
	userKey: "test-user-key",
	secret: SECRET,
	// Placeholder, NOT the operator's real GSM — this file lands in git history
	// and in every PR diff shipped to the CI reviewer. Mirrors twilio.test.ts.
	forwardNumber: "+48500100200",
	apiHost: "api.zadarma.test",
};
const outboundConfig = { ...config, sipExtension: "100" };

/** A live-shaped `pbx_call_id`: direction prefix + sha1 hex (measured 2026-09-05). */
const PBX_CALL_ID = "in_20b67427cf29e305a77f09d12a3976e092787adf";
const CALL_ID_WITH_REC = "1788618987.62914";

/**
 * The webhook recipe: base64 of the HEX hmac-sha1 digest over the concatenated
 * fields — the SAME encoding as request signing. There is no asymmetry; the
 * sentence that used to stand here claimed one, and that claim is what produced
 * a day of production 403s (OPT-232). Only the SIGNED STRING differs between the
 * two directions, never the encoding.
 */
function webhookSignature(
	params: Record<string, string>,
	secret = SECRET,
): string {
	const signed = `${params.pbx_call_id ?? ""}${params.call_id_with_rec ?? ""}`;
	// HEX digest, then base64 of that hex TEXT — the vendor's single
	// `encodeSignature` (`lib/Client.php:112`; PHP `hash_hmac` defaults to hex).
	// This helper computed a RAW digest until 2026-09-08, matching a verifier
	// that was itself wrong, so the pair agreed while production 403'd.
	return Buffer.from(
		createHmac("sha1", secret).update(signed).digest("hex"),
	).toString("base64");
}

function recordEvent(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		event: "NOTIFY_RECORD",
		pbx_call_id: PBX_CALL_ID,
		call_id_with_rec: CALL_ID_WITH_REC,
		...overrides,
	};
}

/** A real `Response` carrying a JSON body, defaulting to Zadarma's success envelope. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

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

/** A `Response` whose body stays open forever — lets a teardown abort be observed. */
function neverEndingResponse(): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]));
		},
	});
	return new Response(body, { status: 200 });
}

function collectingSink(into: Uint8Array[]): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			into.push(chunk);
		},
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("ZadarmaTelephonyProvider — construction", () => {
	it("throws ProviderError(auth) when ZADARMA_SECRET is missing [2.4]", () => {
		const construct = () =>
			new ZadarmaTelephonyProvider({ ...config, secret: undefined });
		expect(construct).toThrow(ProviderError);
		try {
			construct();
		} catch (e) {
			expect(e).toMatchObject({ code: "auth" });
			expect((e as Error).message).toMatch(/secret/);
		}
	});

	it("throws ProviderError(auth) when the user key or forward number is missing", () => {
		expect(
			() => new ZadarmaTelephonyProvider({ ...config, userKey: undefined }),
		).toThrow(ProviderError);
		expect(
			() =>
				new ZadarmaTelephonyProvider({ ...config, forwardNumber: undefined }),
		).toThrow(ProviderError);
	});

	// The SIP extension is outbound-only. If it were in the construction guard,
	// a missing secret would crash the LIVE INBOUND path at boot (F1).
	it("constructs WITHOUT ZADARMA_SIP_EXTENSION [2.5, first half]", () => {
		expect(() => new ZadarmaTelephonyProvider(config)).not.toThrow();
	});

	// The two plan-contract constants. Untested until impl-review F8: nothing else
	// in the suite reads them, yet `webhooks.ts` uses signatureHeader as the header
	// name it looks up, and `jobs/worker.ts` forwards recordingContentType to
	// Deepgram as the upload's content type — a wrong value mis-declares the bytes
	// and no type error would ever fire.
	it("declares the vendor's signature header and recording MIME type [F8]", () => {
		const tel = new ZadarmaTelephonyProvider(config);
		expect(tel.signatureHeader).toBe("signature");
		expect(tel.recordingContentType).toBe("audio/ogg");
	});

	it("has NO buildInboundResponse — its absence is the contract [2.10]", () => {
		// Typed as the INTERFACE on purpose: that is the view every consumer has,
		// and on the concrete class the member does not exist at all (TS refuses the
		// access) — which is itself the strongest form of this assertion. The call
		// scenario lives in Zadarma's panel, so the handler must answer 404 for the
		// voice endpoint rather than invent a response.
		const tel: TelephonyProvider = new ZadarmaTelephonyProvider(config);
		expect(tel.buildInboundResponse).toBeUndefined();
	});
});

describe("ZadarmaTelephonyProvider — verifySignature", () => {
	const tel = new ZadarmaTelephonyProvider(config);

	it("accepts a correctly-computed webhook signature", () => {
		const params = recordEvent();
		expect(
			tel.verifySignature({ signature: webhookSignature(params), params }),
		).toBe(true);
	});

	it("rejects a tampered signature and an absent one", () => {
		const params = recordEvent();
		expect(tel.verifySignature({ signature: "deadbeef", params })).toBe(false);
		// The SDK's fail-open gap: an empty signature must never verify.
		expect(tel.verifySignature({ signature: "", params })).toBe(false);
	});

	it("ignores `url` entirely — Zadarma's MAC does not cover it", () => {
		const params = recordEvent();
		const signature = webhookSignature(params);
		expect(tel.verifySignature({ signature, params })).toBe(true);
		expect(
			tel.verifySignature({ signature, url: "https://elsewhere/x", params }),
		).toBe(true);
	});

	// The signed string is the fields concatenated with NO separator, so one valid
	// signature validates every split of it. Pinning `pbx_call_id`'s exact shape is
	// what collapses that ambiguity — this is the regression test for impl-review F2.
	it("refuses a shifted field boundary that the raw MAC would still accept", () => {
		const forged = {
			event: "NOTIFY_RECORD",
			pbx_call_id: PBX_CALL_ID.slice(0, -1),
			call_id_with_rec: PBX_CALL_ID.slice(-1) + CALL_ID_WITH_REC,
		};
		// Same signed string, therefore the same MAC — the vendor's own recipe
		// cannot tell these apart.
		expect(webhookSignature(forged)).toBe(webhookSignature(recordEvent()));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			tel.verifySignature({
				signature: webhookSignature(forged),
				params: forged,
			}),
		).toBe(false);
		// Refusal is logged under its OWN event name so a shape drift is not
		// mistaken for a broken HMAC recipe (both otherwise surface as a 403).
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("telephony.zadarma.malformed_id"),
		);
	});

	it("does not put the identifier itself in the refusal log — only its shape", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const params = recordEvent({ pbx_call_id: "in_deadbeef" });
		tel.verifySignature({ signature: webhookSignature(params), params });
		const line = errorSpy.mock.calls[0]?.[0] as string;
		expect(line).not.toContain("in_deadbeef");
		expect(line).toContain("<hex:");
	});

	it("refuses a NOTIFY_RECORD with an empty recording id", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const params = recordEvent({ call_id_with_rec: "" });
		expect(
			tel.verifySignature({ signature: webhookSignature(params), params }),
		).toBe(false);
	});

	// The seven ordinary lifecycle events are NOT verified (we do not know their
	// signed field sets) and the primitive stays fail-closed, so it answers false.
	// Turning that into a 200 no-op is the HANDLER's job, decided in phase 3
	// (criterion 3.7 / FU-3) — never by making this return `true`, which would
	// re-create the vendor-SDK fail-open.
	it("refuses every non-NOTIFY_RECORD event — pass-through is the handler's call", () => {
		for (const event of [
			"NOTIFY_START",
			"NOTIFY_ANSWER",
			"NOTIFY_END",
			"NOTIFY_OUT_START",
			"NOTIFY_OUT_END",
			"NOTIFY_INTERNAL",
			"NOTIFY_IVR",
		]) {
			expect(
				tel.verifySignature({
					signature: "anything",
					params: { event, caller_id: "+48500100200" },
				}),
			).toBe(false);
		}
	});
});

describe("ZadarmaTelephonyProvider — handleChallenge", () => {
	const tel = new ZadarmaTelephonyProvider(config);

	it("echoes zd_echo byte-for-byte as text/plain", () => {
		const result = tel.handleChallenge(
			new URL(
				"https://your-app.fly.dev/api/telephony/events?zd_echo=abc%20123",
			),
		);
		expect(result).toEqual({ body: "abc 123", contentType: "text/plain" });
	});

	it("returns null when the challenge parameter is absent", () => {
		expect(
			tel.handleChallenge(
				new URL("https://your-app.fly.dev/api/telephony/events"),
			),
		).toBeNull();
	});

	// F5 (impl-review phase 3). Their challenge is a short random token, so a
	// long value is not the handshake — refusing keeps the unauthenticated
	// endpoint from doubling as a general-purpose text reflector on our origin.
	// Refuse rather than truncate: a truncated echo fails their exact-equality
	// check anyway, and 404 says the honest thing.
	it("refuses an over-long echo instead of reflecting it", () => {
		const long = "a".repeat(257);
		expect(
			tel.handleChallenge(
				new URL(
					`https://your-app.fly.dev/api/telephony/events?zd_echo=${long}`,
				),
			),
		).toBeNull();
	});

	// The boundary itself, so a future edit cannot quietly tighten the cap below
	// a value the vendor might legitimately send.
	it("still echoes a value exactly at the cap", () => {
		const atCap = "a".repeat(256);
		expect(
			tel.handleChallenge(
				new URL(
					`https://your-app.fly.dev/api/telephony/events?zd_echo=${atCap}`,
				),
			),
		).toEqual({ body: atCap, contentType: "text/plain" });
	});
});

describe("ZadarmaTelephonyProvider — placeCall (stubbed fetch)", () => {
	const callbackUrl = "https://your-app.fly.dev/api/telephony/events";
	const recipient = "+48600100200";

	it("throws ProviderError(auth) and makes NO request without the SIP extension [2.5]", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const inboundOnly = new ZadarmaTelephonyProvider(config);
		const promise = inboundOnly.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "auth" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("GETs the signed callback endpoint with from=GSM, to=recipient, sip=extension", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ status: "success" }));
		vi.stubGlobal("fetch", fetchMock);

		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		const result = await tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		const requested = new URL(url as string);
		// Trailing slash is load-bearing: the signature covers the path verbatim.
		expect(requested.pathname).toBe("/v1/request/callback/");
		expect(requested.searchParams.get("from")).toBe(config.forwardNumber);
		expect(requested.searchParams.get("to")).toBe(recipient);
		expect(requested.searchParams.get("sip")).toBe("100");
		// EXACT string, not a set of params read back (impl-review F8): what must go
		// on the wire is the SIGNED `paramsString` itself, sorted and with
		// `format=json` folded in before signing. A mutation that rebuilt the query
		// freshly would satisfy every per-param assertion above and still produce a
		// 401 indistinguishable from a bad key — the failure mode
		// `zadarma-signature.ts` calls fatal.
		expect(requested.search).toBe(
			`?format=json&from=${encodeURIComponent(config.forwardNumber)}&sip=100&to=${encodeURIComponent(recipient)}`,
		);
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^test-user-key:/,
		);
		// No vendor id in the response → a synthesized one that feeds only the
		// audit line. It must NOT be mistaken for the later `pbx_call_id`.
		expect(result.callSid).toMatch(/^zadarma-callback-/);
	});

	it("maps HTTP 200 + {status:'error'} to invalid_response, NOT success [2.6]", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "not enough money" }),
				),
		);
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		const promise = tel.placeCall({
			to: recipient,
			recordingStatusCallbackUrl: callbackUrl,
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	// impl-review F5: this message is persisted into processing_jobs.last_error and
	// printed by calls.ts. A vendor error quoting the dialled number would put a
	// phone number into a job row or a log line — neither is one of the places
	// allowed to hold one (`schema.ts`; since FR-025 a vendor-supplied number
	// lives only in `conversations.counterparty_e164`, via the counterparty sweep).
	it("redacts digits out of the vendor message before it can be persisted [F5]", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					status: "error",
					message: "cannot call 48600100200 from this account",
				}),
			),
		);
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		const err = await tel
			.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl })
			.then(
				() => null,
				(e: unknown) => e as Error,
			);
		const message = err?.message ?? "";
		expect(message).not.toContain("48600100200");
		expect(message).toContain("<phone>");
		// The diagnostic survives — only the digits are gone.
		expect(message).toContain("cannot call");
	});

	// caller-identity-in-archive phase 2: the old local mask matched only an
	// unbroken digit run, so a vendor message quoting the number WITH separators
	// (the way a human or a PBX formats it) passed through untouched.
	it("redacts a number written with separators out of the vendor message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					status: "error",
					message: "cannot call +48 600 100 200 from this account",
				}),
			),
		);
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		const err = await tel
			.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl })
			.then(
				() => null,
				(e: unknown) => e as Error,
			);
		const message = err?.message ?? "";
		expect(message).not.toMatch(/600.?100.?200/);
		expect(message).toContain("cannot call <phone> from this account");
	});

	// Same phase: the mask used to run AFTER the 120-char cut, so a number
	// straddling the cut kept its leading digits. Masking now happens first.
	it("masks a number that straddles the 120-char cut", async () => {
		const padding = "x".repeat(112);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					status: "error",
					message: `${padding} +48600100200 rejected`,
				}),
			),
		);
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		const err = await tel
			.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl })
			.then(
				() => null,
				(e: unknown) => e as Error,
			);
		const message = err?.message ?? "";
		expect(message).not.toMatch(/\d{3,}/);
		expect(message).toContain("<phone>");
	});

	it("maps 401 to auth and 500 to transport", async () => {
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
		);
		await expect(
			tel.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl }),
		).rejects.toMatchObject({ code: "auth" });

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
		);
		await expect(
			tel.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl }),
		).rejects.toMatchObject({ code: "transport" });
	});

	// impl-review F4: the guard asserts success POSITIVELY. A 200 JSON object with
	// no `status` at all used to sail through and report a call that was never placed.
	it("maps a 200 envelope with NO status field to invalid_response [F4]", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ some: "other shape" })),
		);
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		await expect(
			tel.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl }),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps a non-JSON 200 body to invalid_response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(new Response("<html>nope</html>", { status: 200 })),
		);
		const tel = new ZadarmaTelephonyProvider(outboundConfig);
		await expect(
			tel.placeCall({ to: recipient, recordingStatusCallbackUrl: callbackUrl }),
		).rejects.toMatchObject({ code: "invalid_response" });
	});
});

describe("ZadarmaTelephonyProvider — streamRecording (stubbed fetch)", () => {
	const tel = new ZadarmaTelephonyProvider(config);
	const LINK = "https://api.zadarma.test/v1/pbx/record/download/aaa/bbb";

	it("makes TWO requests and streams chunks through without buffering [2.7]", async () => {
		const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ status: "success", link: LINK }))
			.mockResolvedValueOnce(streamResponse(chunks));
		vi.stubGlobal("fetch", fetchMock);

		const collected: Uint8Array[] = [];
		await tel.streamRecording(
			{ recordingSid: CALL_ID_WITH_REC },
			collectingSink(collected),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		// Step 1: signed, carries the recording id + a link lifetime.
		const [linkUrl, linkInit] = fetchMock.mock.calls[0] ?? [];
		const requested = new URL(linkUrl as string);
		expect(requested.pathname).toBe("/v1/pbx/record/request/");
		expect(requested.searchParams.get("call_id")).toBe(CALL_ID_WITH_REC);
		expect(requested.searchParams.get("lifetime")).toBeTruthy();
		expect((linkInit.headers as Record<string, string>).Authorization).toMatch(
			/^test-user-key:/,
		);
		// Step 2: the link carries its own capability — UNauthenticated.
		const [mediaUrl, mediaInit] = fetchMock.mock.calls[1] ?? [];
		expect(mediaUrl).toBe(LINK);
		expect(mediaInit?.headers).toBeUndefined();
		// The sink saw the SEPARATE chunks — proof the body was piped, not
		// materialized into one buffer on a 256 MB Machine.
		expect(collected).toHaveLength(2);
		expect(collected.flatMap((c) => [...c])).toEqual([1, 2, 3, 4]);
	});

	it("accepts the `links[0]` variant of the link response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					jsonResponse({ status: "success", links: [LINK] }),
				)
				.mockResolvedValueOnce(streamResponse([new Uint8Array([9])])),
		);
		const collected: Uint8Array[] = [];
		await expect(
			tel.streamRecording(
				{ recordingSid: CALL_ID_WITH_REC },
				collectingSink(collected),
			),
		).resolves.toBeUndefined();
		expect(collected.flatMap((c) => [...c])).toEqual([9]);
	});

	it("maps an error envelope on the LINK step to invalid_response [2.6]", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "record not found" }),
				),
		);
		await expect(
			tel.streamRecording({ recordingSid: "x" }, collectingSink([])),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps a link response with no link at all to invalid_response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ status: "success" })),
		);
		await expect(
			tel.streamRecording({ recordingSid: "x" }, collectingSink([])),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps a 403 on the media step to auth and a mid-stream drop to transport", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ status: "success", link: LINK }))
				.mockResolvedValueOnce(new Response(null, { status: 403 })),
		);
		await expect(
			tel.streamRecording({ recordingSid: "x" }, collectingSink([])),
		).rejects.toMatchObject({ code: "auth" });

		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ status: "success", link: LINK }))
				.mockResolvedValueOnce(erroringResponse()),
		);
		await expect(
			tel.streamRecording({ recordingSid: "x" }, collectingSink([])),
		).rejects.toMatchObject({ code: "transport" });
	});

	// The worker's telephony→STT bridge aborts the pull once transcription
	// settles, passing a ProviderError as the abort reason. That reason must reach
	// the job layer intact — a raw DOMException would miss the discriminator the
	// worker switches on.
	it("propagates the abort reason as a ProviderError, not a raw stream error [2.8]", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ status: "success", link: LINK }))
				.mockResolvedValueOnce(neverEndingResponse()),
		);
		const controller = new AbortController();
		const reason = new ProviderError({
			code: "rate_limited",
			message: "stt settled first",
		});
		const promise = tel.streamRecording(
			{ recordingSid: "x" },
			new WritableStream<Uint8Array>({
				write() {
					// Never resolves the whole stream — the abort is what ends it.
				},
			}),
			{ signal: controller.signal },
		);
		controller.abort(reason);
		await expect(promise).rejects.toBe(reason);
	});

	it("forwards the signal to the LINK request too — no hanging first step [2.8]", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ status: "success", link: LINK }))
			.mockResolvedValueOnce(streamResponse([new Uint8Array([1])]));
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		await tel.streamRecording({ recordingSid: "x" }, collectingSink([]), {
			signal: controller.signal,
		});
		const [, linkInit] = fetchMock.mock.calls[0] ?? [];
		expect(linkInit.signal).toBe(controller.signal);
	});
});

describe("ZadarmaTelephonyProvider — deleteRecording (stubbed fetch)", () => {
	const tel = new ZadarmaTelephonyProvider(config);

	it("DELETEs the signed record endpoint with the recording id", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ status: "success" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			tel.deleteRecording({ recordingSid: CALL_ID_WITH_REC }),
		).resolves.toBeUndefined();
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.zadarma.test/v1/pbx/record/request/");
		expect(init.method).toBe("DELETE");
		// Non-GET carries the SIGNED params string as the form body — asserted
		// EXACTLY, including `format=json`, which is part of the signed text and
		// whose absence on the wire is a silent 401 (impl-review F8).
		expect(String(init.body)).toBe("call_id=1788618987.62914&format=json");
	});

	// INVERTED 2026-09-08 (impl-review F1). This test used to assert that a bare
	// HTTP 404 is idempotent success — and so did the plan's own criterion 2.9.
	// Both were wrong, and the test froze the error the way the webhook-signature
	// vector once did: it pinned our own guess as if it were the vendor's
	// behaviour, so the suite defended the defect instead of catching it.
	//
	// Twilio addresses the recording in the URL PATH, so 404 there means "that
	// recording is gone". Zadarma requests a FIXED path with `call_id` in the
	// signed BODY, so a 404 cannot describe the recording — only a missing path or
	// verb. Reading it as success stamps `recordingDeletedAt`, drops the row out of
	// the delete sweep forever, and leaves the audio at the vendor while the system
	// claims it is gone (FR-002 + the EU-residency posture).
	it("refuses to call a bare HTTP 404 a deletion [2.9, inverted]", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "gone" }),
		).rejects.toMatchObject({ code: "transport" });
	});

	// The companion property: a 404 must NOT be silently swallowed, but it also
	// must not be swallowed LOUDLY into the "assumed gone" audit line — that line
	// means "the vendor told us it is gone", which a 404 never says.
	it("does not emit delete_assumed_gone for a bare 404 [2.9, inverted]", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			tel.deleteRecording({ recordingSid: "gone" }),
		).rejects.toBeInstanceOf(ProviderError);
		expect(errorSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("telephony.zadarma.delete_assumed_gone"),
		);
		errorSpy.mockRestore();
	});

	// This provider reports "already gone" the SAME way it reports every other
	// failure — HTTP 200 with an error envelope. Without this branch a repeated
	// delete would be a hard error and would wedge the delete sweeper.
	it("treats the 'not found' error envelope as idempotent success [2.9]", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "Record not found" }),
				),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "gone" }),
		).resolves.toBeUndefined();
	});

	// REGRESSION, impl-review F1. The looser predicate this replaced matched
	// "user not found" on an HTTP 401 — a rotated key would have marked every
	// recording deleted without deleting one, and the row leaves the sweep set
	// forever. Both guards are pinned: the status gate and the anchored wording.
	it("does NOT treat an auth failure as a successful delete [F1]", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "user not found" }, 401),
				),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "x" }),
		).rejects.toMatchObject({ code: "auth" });
	});

	// The DELETE verb/path has never been exercised live, so "method not found"
	// is the realistic wrong-guess response — it must NOT read as "already gone".
	it("does NOT treat 'API method not found' as a successful delete [F1]", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "API method not found" }),
				),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "x" }),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("audits the assumed-gone branch — it asserts a deletion it did not do [F1]", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "Record not found" }),
				),
		);
		await tel.deleteRecording({ recordingSid: "gone" });
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("telephony.zadarma.delete_assumed_gone"),
		);
	});

	// The narrowness is the point: a false success would mark as deleted a
	// recording that still exists at the provider — the orphaned-recording failure
	// this migration is already paying for on the abandoned Twilio account.
	it("still THROWS on an unrelated error envelope", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "access denied" }),
				),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "x" }),
		).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps a 500 to transport and a network throw to transport", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "x" }),
		).rejects.toMatchObject({ code: "transport" });

		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		);
		await expect(
			tel.deleteRecording({ recordingSid: "x" }),
		).rejects.toMatchObject({ code: "transport" });
	});
});

describe("ZadarmaTelephonyProvider — listRecordingsAwaitingCapture (stubbed fetch)", () => {
	/**
	 * Capture reconciliation's one question to the vendor: "what is still lying
	 * at your end?" Everything asserted here fails SILENTLY when it regresses —
	 * a dropped `version=2`, a window in the wrong clock, or an error envelope
	 * read as success all produce the same symptom, "nothing is pending", which
	 * is indistinguishable from a healthy quiet account.
	 */

	/** 2026-09-08 13:59:47Z — the lost call, in UTC. Account clock reads 15:59:47. */
	const SUMMER_UTC = new Date("2026-09-08T13:59:47.000Z");
	/** Same wall-clock date in January, when Poland is on CET (UTC+1). */
	const WINTER_UTC = new Date("2026-01-08T13:59:47.000Z");

	function statsResponse(stats: unknown[]): Response {
		return jsonResponse({ status: "success", stats });
	}

	it("GETs the signed statistics path with version=2 [1.9]", async () => {
		const fetchMock = vi.fn().mockResolvedValue(statsResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		const tel = new ZadarmaTelephonyProvider(config);
		await tel.listRecordingsAwaitingCapture({
			since: new Date(SUMMER_UTC.getTime() - 24 * 3600_000),
			until: SUMMER_UTC,
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		const requested = new URL(url as string);
		// Trailing slash is load-bearing: the signature covers the path verbatim.
		expect(requested.pathname).toBe("/v1/statistics/pbx/");
		// WITHOUT `version=2` the response omits `pbx_call_id` entirely and still
		// looks well-formed — every row would be dropped by the id check and the
		// debt ledger would read permanently empty, with no error anywhere.
		expect(requested.searchParams.get("version")).toBe("2");
		// EXACT string, not a set of params read back: what must go on the wire is
		// the SIGNED `paramsString` itself (sorted, `format=json` folded in before
		// signing). A rebuilt query satisfies every per-param assertion above and
		// still yields a 401 indistinguishable from a bad key.
		// `limit` is asked for BY NAME, not left to the vendor's default, because
		// that is what makes a full page detectable (see the truncation guard).
		expect(requested.searchParams.get("limit")).toBe("1000");
		expect(requested.search).toBe(
			"?end=2026-09-08+15%3A59%3A47&format=json&limit=1000&start=2026-09-07+15%3A59%3A47&version=2",
		);
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^test-user-key:/,
		);
	});

	// The measurement behind this: `/v1/statistics/*` interprets start/end in
	// ACCOUNT time (UTC+2 on 2026-09-08), so a window computed in UTC loses the
	// most recent two hours — exactly the calls reconciliation is for.
	it("expresses the window in the account's clock, not UTC [1.8]", async () => {
		const fetchMock = vi.fn().mockResolvedValue(statsResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		const tel = new ZadarmaTelephonyProvider(config);
		await tel.listRecordingsAwaitingCapture({
			since: SUMMER_UTC,
			until: new Date(SUMMER_UTC.getTime() + 3600_000),
		});

		const requested = new URL(fetchMock.mock.calls[0]?.[0] as string);
		expect(requested.searchParams.get("start")).toBe("2026-09-08 15:59:47");
		expect(requested.searchParams.get("end")).toBe("2026-09-08 16:59:47");
	});

	/**
	 * The offset is a ZONE, not the constant `+120` the measurement was taken at.
	 * Poland leaves CEST in late October, and the error is not symmetric: sending
	 * a winter timestamp an hour LATE would push the reconcile window's `end`
	 * into the future and silently delete the mandatory grace period, which is
	 * what stops the sweep reaching a recording before the file is fetchable.
	 */
	it("follows DST rather than freezing the measured +2 offset [1.8]", async () => {
		const fetchMock = vi.fn().mockResolvedValue(statsResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		const tel = new ZadarmaTelephonyProvider(config);
		await tel.listRecordingsAwaitingCapture({
			since: WINTER_UTC,
			until: WINTER_UTC,
		});

		const requested = new URL(fetchMock.mock.calls[0]?.[0] as string);
		expect(requested.searchParams.get("start")).toBe("2026-01-08 14:59:47");
	});

	it("maps the vendor's rows onto PendingRecording, resident legs only", async () => {
		const stats = [
			{
				pbx_call_id: PBX_CALL_ID,
				call_id: "1788883091.111111",
				is_recorded: false,
				sip: "0",
			},
			{
				pbx_call_id: PBX_CALL_ID,
				call_id: "1788883091.244520",
				is_recorded: "true",
				sip: "100",
				clid: "+48500100200",
			},
		];
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statsResponse(stats)));

		const tel = new ZadarmaTelephonyProvider(config);
		const pending = await tel.listRecordingsAwaitingCapture({
			since: SUMMER_UTC,
			until: SUMMER_UTC,
		});

		expect(pending).toEqual([
			{ callSid: PBX_CALL_ID, recordingSid: "1788883091.244520" },
		]);
		// The vendor's rows carry phone numbers; nothing may ride out on them.
		expect(JSON.stringify(pending)).not.toContain("48500100200");
	});

	// HTTP 200 + {status:"error"} is this vendor's failure envelope. Read as a
	// success it becomes "nothing is pending" — an auth failure that looks like a
	// healthy quiet account, forever.
	it("maps the HTTP-200 error envelope to a ProviderError, not an empty list", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "user not found" }),
				),
		);
		const tel = new ZadarmaTelephonyProvider(config);
		const promise = tel.listRecordingsAwaitingCapture({
			since: SUMMER_UTC,
			until: SUMMER_UTC,
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps HTTP 401 to auth", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ status: "error" }, 401)),
		);
		const tel = new ZadarmaTelephonyProvider(config);
		await expect(
			tel.listRecordingsAwaitingCapture({
				since: SUMMER_UTC,
				until: SUMMER_UTC,
			}),
		).rejects.toMatchObject({ code: "auth" });
	});

	// An envelope the mapper does not recognize must NOT degrade into "nothing is
	// pending" — that is the silent blindness this feature exists to remove.
	it("throws invalid_response on an unrecognized envelope shape", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(jsonResponse({ status: "success", stats: "none" })),
		);
		const tel = new ZadarmaTelephonyProvider(config);
		const promise = tel.listRecordingsAwaitingCapture({
			since: SUMMER_UTC,
			until: SUMMER_UTC,
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
		// The body is a list of calls, numbers included — none of it may be echoed
		// into a message destined for a log line.
		await expect(promise).rejects.toMatchObject({
			message: expect.stringMatching(/unrecognized envelope shape/),
		});
	});

	it("returns an empty list for a genuinely quiet window", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statsResponse([])));
		const tel = new ZadarmaTelephonyProvider(config);
		await expect(
			tel.listRecordingsAwaitingCapture({
				since: SUMMER_UTC,
				until: SUMMER_UTC,
			}),
		).resolves.toEqual([]);
	});
});

describe("ZadarmaTelephonyProvider — resolveCounterparties (stubbed fetch)", () => {
	/**
	 * FR-025. The same request as `listRecordingsAwaitingCapture`, read by the
	 * counterparty mapper. Everything asserted here fails SILENTLY when it
	 * regresses: a dropped `version=2` means rows with no `pbx_call_id`, which
	 * the mapper skips, so every conversation sits `pending` until it expires to
	 * `unavailable` — no error anywhere.
	 */
	const SUMMER_UTC = new Date("2026-10-19T16:18:39.000Z");

	function statsResponse(stats: unknown[]): Response {
		return jsonResponse({ status: "success", stats });
	}

	it("GETs the same signed statistics request: path, version=2, limit, account clock", async () => {
		const fetchMock = vi.fn().mockResolvedValue(statsResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		const tel = new ZadarmaTelephonyProvider(config);
		await tel.resolveCounterparties({
			since: new Date(SUMMER_UTC.getTime() - 48 * 3600_000),
			until: SUMMER_UTC,
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		const requested = new URL(url as string);
		expect(requested.pathname).toBe("/v1/statistics/pbx/");
		expect(requested.searchParams.get("version")).toBe("2");
		expect(requested.searchParams.get("limit")).toBe("1000");
		// Account clock (CEST on this date): 16:18:39Z → 18:18:39.
		expect(requested.search).toBe(
			"?end=2026-10-19+18%3A18%3A39&format=json&limit=1000&start=2026-10-17+18%3A18%3A39&version=2",
		);
		expect((init.headers as Record<string, string>).Authorization).toMatch(
			/^test-user-key:/,
		);
	});

	it("maps an inbound and an outbound call by their measured leg rules", async () => {
		const outboundId = "out_4694c79062ff9e0cac2bd7783749f5ef1b500190";
		const stats = [
			// Inbound: clid on both legs, destination = own DID (a number).
			{
				pbx_call_id: PBX_CALL_ID,
				call_id: "1792428177.2940004",
				sip: "0",
				clid: '"Optimate Labs" <+48500100200>',
				destination: 48172000000,
				seconds: 9,
				is_recorded: "false",
			},
			{
				pbx_call_id: PBX_CALL_ID,
				call_id: "1792428178.2940034",
				sip: "100",
				clid: '"Optimate Labs" <+48500100200>',
				destination: 48172000000,
				seconds: 42,
				is_recorded: "false",
			},
			// Outbound: clid = own GSM, destination = the dialled party (a number).
			{
				pbx_call_id: outboundId,
				call_id: "1792426717.2547695",
				sip: "+48500100300",
				clid: '"" <+48500100300>',
				destination: 48600700800,
				seconds: 45,
				is_recorded: "false",
			},
		];
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statsResponse(stats)));

		const tel = new ZadarmaTelephonyProvider(config);
		const resolved = await tel.resolveCounterparties({
			since: SUMMER_UTC,
			until: SUMMER_UTC,
		});

		expect(resolved).toEqual([
			{
				callSid: PBX_CALL_ID,
				outcome: "known",
				rawNumber: "+48500100200",
				nameHint: "Optimate Labs",
				direction: "inbound",
			},
			{
				callSid: outboundId,
				outcome: "known",
				rawNumber: "48600700800",
				direction: "outbound",
			},
		]);
		const serialized = JSON.stringify(resolved);
		expect(serialized).not.toContain("48172000000"); // own DID
		expect(serialized).not.toContain("500100300"); // own GSM
	});

	it("maps the HTTP-200 error envelope to a ProviderError, not an empty list", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ status: "error", message: "user not found" }),
				),
		);
		const tel = new ZadarmaTelephonyProvider(config);
		const promise = tel.resolveCounterparties({
			since: SUMMER_UTC,
			until: SUMMER_UTC,
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("maps HTTP 401 to auth", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ status: "error" }, 401)),
		);
		const tel = new ZadarmaTelephonyProvider(config);
		await expect(
			tel.resolveCounterparties({ since: SUMMER_UTC, until: SUMMER_UTC }),
		).rejects.toMatchObject({ code: "auth" });
	});

	it("throws invalid_response on an unrecognized envelope shape, echoing no vendor text", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(jsonResponse({ status: "success", stats: "none" })),
		);
		const tel = new ZadarmaTelephonyProvider(config);
		const promise = tel.resolveCounterparties({
			since: SUMMER_UTC,
			until: SUMMER_UTC,
		});
		await expect(promise).rejects.toMatchObject({
			code: "invalid_response",
			message: expect.stringMatching(/unrecognized envelope shape/),
		});
	});

	// "No row for this call" is a legitimate answer (the resolver leaves it
	// pending), so a quietly truncated page would be indistinguishable from it
	// and would leave conversations pending FOREVER. A full page fails loudly.
	it("throws invalid_response on a full page instead of returning a partial list", async () => {
		const stats = Array.from({ length: 1000 }, (_, i) => ({
			pbx_call_id: `in_${i.toString(16).padStart(40, "0")}`,
			clid: '"X" <+48500100200>',
			destination: 48172000000,
			seconds: 1,
		}));
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statsResponse(stats)));
		const tel = new ZadarmaTelephonyProvider(config);
		await expect(
			tel.resolveCounterparties({ since: SUMMER_UTC, until: SUMMER_UTC }),
		).rejects.toMatchObject({
			code: "invalid_response",
			message: expect.stringMatching(/full page/),
		});
	});

	it("returns an empty list for a genuinely quiet window", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statsResponse([])));
		const tel = new ZadarmaTelephonyProvider(config);
		await expect(
			tel.resolveCounterparties({ since: SUMMER_UTC, until: SUMMER_UTC }),
		).resolves.toEqual([]);
	});
});
