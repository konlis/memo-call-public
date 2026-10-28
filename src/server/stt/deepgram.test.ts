import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";

// `DeepgramSttProvider`'s constructor reads `env.DEEPGRAM_*` through `~/env`,
// which @t3-oss/env-nextjs parses + freezes once at import — so `vi.stubEnv`
// would be invisible. Mock `~/env` with a hoisted mutable holder instead; the
// provider reads the fields at *construction* time, so mutating the holder
// before `new DeepgramSttProvider()` gives per-test control (present vs missing
// key, custom host/model). Bonus: the real env.js never runs, so this file needs
// no DATABASE_URL.
const { envMock } = vi.hoisted(() => ({
	envMock: {
		DEEPGRAM_API_KEY: "test-key" as string | undefined,
		DEEPGRAM_STT_HOST: undefined as string | undefined,
		DEEPGRAM_MODEL: undefined as string | undefined,
	},
}));
vi.mock("~/env", () => ({ env: envMock }));

import { DeepgramSttProvider } from "~/server/stt/deepgram";
import type { AudioSource } from "~/server/stt/types";

/** A trivial 3-byte readable so `open()` returns a real stream. */
function fakeStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new Uint8Array([1, 2, 3]));
			c.close();
		},
	});
}

function streamSource(
	over: Partial<Extract<AudioSource, { kind: "stream" }>> = {},
): AudioSource {
	return {
		kind: "stream",
		open: fakeStream,
		contentType: "audio/wav",
		...over,
	};
}

/** Build a Deepgram-shaped JSON Response. */
function deepgramJson(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	envMock.DEEPGRAM_API_KEY = "test-key";
	envMock.DEEPGRAM_STT_HOST = undefined;
	envMock.DEEPGRAM_MODEL = undefined;
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("DeepgramSttProvider — construction", () => {
	it("throws ProviderError(auth) at construction when the API key is absent", () => {
		envMock.DEEPGRAM_API_KEY = undefined;
		let caught: unknown;
		try {
			new DeepgramSttProvider();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("auth");
	});

	it("constructs with a key present (no throw)", () => {
		expect(() => new DeepgramSttProvider()).not.toThrow();
	});
});

describe("DeepgramSttProvider — request shape", () => {
	it("POSTs the streamed body to the EU endpoint with multichannel + language=pl", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
				metadata: { duration: 1 },
			}),
		);

		await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
			language: "pl-PL",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit & { duplex?: string },
		];
		expect(url).toContain("https://api.eu.deepgram.com/v1/listen");
		expect(url).toContain("model=nova-3");
		expect(url).toContain("language=pl");
		expect(url).toContain("multichannel=true");
		expect(url).toContain("utterances=true");
		expect(url).toContain("punctuate=true");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Token test-key");
		expect(headers["Content-Type"]).toBe("audio/wav");
		expect(init.duplex).toBe("half");
		expect(init.body).toBeInstanceOf(ReadableStream);
	});

	it("honors custom host + model from env", async () => {
		envMock.DEEPGRAM_STT_HOST = "api.test.deepgram.com";
		envMock.DEEPGRAM_MODEL = "nova-2";
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
				metadata: { duration: 1 },
			}),
		);

		await new DeepgramSttProvider().transcribe({ audio: streamSource() });

		const [url] = fetchMock.mock.calls[0] as [string, unknown];
		expect(url).toContain("https://api.test.deepgram.com/v1/listen");
		expect(url).toContain("model=nova-2");
	});

	it("sends the source contentType when provided", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
			}),
		);

		await new DeepgramSttProvider().transcribe({
			audio: streamSource({ contentType: "audio/mpeg" }),
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
			"audio/mpeg",
		);
	});
});

describe("DeepgramSttProvider — language handling", () => {
	it("maps BCP-47 'pl-PL' → Deepgram 'pl' and reports the BCP-47 form back", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
			language: "pl-PL",
		});

		const [url] = fetchMock.mock.calls[0] as [string, unknown];
		expect(url).toContain("language=pl");
		expect(result.language).toBe("pl-PL");
	});

	it("falls back to pl-PL on an empty/blank language arg", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
			language: "  ",
		});

		const [url] = fetchMock.mock.calls[0] as [string, unknown];
		expect(url).toContain("language=pl");
		expect(result.language).toBe("pl-PL");
	});
});

// These responses carry NO `results.utterances`, so they exercise the
// per-channel fallback path (test case 3: utterances-absent → per-channel map).
describe("DeepgramSttProvider — per-channel mapping (utterances-absent fallback)", () => {
	it("maps each channel to one speaker segment with text + word-derived timings", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [
						{
							alternatives: [
								{
									transcript: "Dzień dobry.",
									words: [
										{ start: 0, end: 1.2 },
										{ start: 1.3, end: 2.0 },
									],
								},
							],
						},
						{
							alternatives: [
								{ transcript: "Witam.", words: [{ start: 2.1, end: 3.0 }] },
							],
						},
					],
				},
				metadata: { duration: 4.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
			language: "pl-PL",
		});

		expect(result.segments).toEqual([
			{ speaker: "Speaker A", text: "Dzień dobry.", startMs: 0, endMs: 2000 },
			{ speaker: "Speaker B", text: "Witam.", startMs: 2100, endMs: 3000 },
		]);
		expect(result.language).toBe("pl-PL");
		expect(result.durationMs).toBe(4000);
	});

	it("skips a silent channel but keeps the surviving leg's physical-index speaker", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [
						{ alternatives: [{ transcript: "   " }] }, // channel 0 silent
						{ alternatives: [{ transcript: "Halo?" }] }, // channel 1 speaks
					],
				},
				metadata: { duration: 2 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		expect(result.segments).toEqual([
			{
				speaker: "Speaker B",
				text: "Halo?",
				startMs: undefined,
				endMs: undefined,
			},
		]);
	});
});

describe("DeepgramSttProvider — utterance mapping (time-ordered turns)", () => {
	it("interleaves cross-channel utterances into time order with A/B labels, preferring utterances over per-channel transcripts", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					// Per-channel transcripts are present but MUST be ignored when
					// utterances exist — assert none of this run-on text surfaces.
					channels: [
						{ alternatives: [{ transcript: "Halo? Dziękuję." }] },
						{ alternatives: [{ transcript: "Witam, w czym mogę pomóc?" }] },
					],
					// Supplied OUT of start-time order to prove we sort, not trust order.
					utterances: [
						{
							channel: 1,
							start: 2.0,
							end: 3.0,
							transcript: "Witam, w czym mogę pomóc?",
						},
						{ channel: 0, start: 0.0, end: 1.5, transcript: "Halo?" },
						{ channel: 0, start: 4.0, end: 5.0, transcript: "Dziękuję." },
					],
				},
				metadata: { duration: 5.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
			language: "pl-PL",
		});

		expect(result.segments).toEqual([
			{ speaker: "Speaker A", text: "Halo?", startMs: 0, endMs: 1500 },
			{
				speaker: "Speaker B",
				text: "Witam, w czym mogę pomóc?",
				startMs: 2000,
				endMs: 3000,
			},
			{ speaker: "Speaker A", text: "Dziękuję.", startMs: 4000, endMs: 5000 },
		]);
		expect(result.durationMs).toBe(5000);
	});

	it("coalesces consecutive same-channel utterances into one turn (a new turn starts only when the other channel speaks)", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [
						{ alternatives: [{ transcript: "ignored" }] },
						{ alternatives: [{ transcript: "ignored" }] },
					],
					// One speaker's monologue arrives as several utterances split on
					// silence gaps; supplied OUT of order to also prove the sort. Without
					// coalescing this would render as four run-on "Speaker A" fragments.
					utterances: [
						{ channel: 0, start: 2.2, end: 3.0, transcript: "obsługi klienta" },
						{
							channel: 1,
							start: 3.5,
							end: 4.5,
							transcript: "Obsługa klienta mówi pan ok",
						},
						{ channel: 0, start: 0.0, end: 1.0, transcript: "Już Panu mówię" },
						{ channel: 0, start: 5.0, end: 6.0, transcript: "Dziękuję." },
						{ channel: 0, start: 1.5, end: 2.0, transcript: "w obrębie" },
					],
				},
				metadata: { duration: 6.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		// ch0 run (0.0 / 1.5 / 2.2) → one turn; ch1 takes the floor → new turn;
		// ch0 again at 5.0 → a fresh turn (not re-merged into the first).
		expect(result.segments).toEqual([
			{
				speaker: "Speaker A",
				text: "Już Panu mówię w obrębie obsługi klienta",
				startMs: 0,
				endMs: 3000,
			},
			{
				speaker: "Speaker B",
				text: "Obsługa klienta mówi pan ok",
				startMs: 3500,
				endMs: 4500,
			},
			{ speaker: "Speaker A", text: "Dziękuję.", startMs: 5000, endMs: 6000 },
		]);
		expect(result.durationMs).toBe(6000);
	});

	it("drops a blank utterance mid-run so the surrounding same-channel turn still merges", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [{ alternatives: [{ transcript: "x" }] }],
					utterances: [
						{ channel: 0, start: 0.0, end: 1.0, transcript: "Tak" },
						{ channel: 0, start: 1.2, end: 1.4, transcript: "   " }, // blank
						{ channel: 0, start: 1.6, end: 2.5, transcript: "zgadza się" },
					],
				},
				metadata: { duration: 3.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		// Blank filtered first → the two real ch0 utterances are consecutive → one
		// turn; endMs comes from the last real utterance (2.5s), not the blank.
		expect(result.segments).toEqual([
			{ speaker: "Speaker A", text: "Tak zgadza się", startMs: 0, endMs: 2500 },
		]);
	});

	it("keeps the last DEFINED end when a later same-channel utterance omits `end`", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [{ alternatives: [{ transcript: "x" }] }],
					utterances: [
						{ channel: 0, start: 0.0, end: 1.0, transcript: "Tak" },
						{ channel: 0, start: 1.2, end: 2.0, transcript: "no więc" },
						// `end` omitted — the endMs guard must NOT clobber the run's endMs
						// back to undefined; it stays at the last DEFINED end (2.0s).
						{ channel: 0, start: 2.2, transcript: "zgadza się" },
					],
				},
				metadata: { duration: 3.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		expect(result.segments).toEqual([
			{
				speaker: "Speaker A",
				text: "Tak no więc zgadza się",
				startMs: 0,
				endMs: 2000,
			},
		]);
	});

	it("breaks an equal-start tie by channel index (Speaker A before Speaker B)", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [
						{ alternatives: [{ transcript: "A" }] },
						{ alternatives: [{ transcript: "B" }] },
					],
					// Both start at 1.0s; channel 1 listed first → must reorder to ch0 first.
					utterances: [
						{ channel: 1, start: 1.0, end: 2.0, transcript: "B mówi" },
						{ channel: 0, start: 1.0, end: 2.5, transcript: "A mówi" },
					],
				},
				metadata: { duration: 3.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		expect(result.segments).toEqual([
			{ speaker: "Speaker A", text: "A mówi", startMs: 1000, endMs: 2500 },
			{ speaker: "Speaker B", text: "B mówi", startMs: 1000, endMs: 2000 },
		]);
	});

	it("skips a blank-transcript utterance and maps duration + per-utterance timings/labels", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [{ alternatives: [{ transcript: "Tak." }] }],
					utterances: [
						{ channel: 0, start: 0.0, end: 1.0, transcript: "   " }, // skipped
						{ channel: 1, start: 1.2, end: 2.4, transcript: "Tak." },
					],
				},
				metadata: { duration: 3.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		expect(result.segments).toEqual([
			{ speaker: "Speaker B", text: "Tak.", startMs: 1200, endMs: 2400 },
		]);
		expect(result.durationMs).toBe(3000);
	});

	it("falls back to per-channel mapping when utterances is present but all-blank", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [
						{ alternatives: [{ transcript: "Dzień dobry." }] },
						{ alternatives: [{ transcript: "Witam." }] },
					],
					utterances: [{ channel: 0, start: 0, end: 1, transcript: "  " }],
				},
				metadata: { duration: 2.0 },
			}),
		);

		const result = await new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});

		// All utterances blank → utterance path yields [] → per-channel fallback.
		expect(result.segments).toEqual([
			{
				speaker: "Speaker A",
				text: "Dzień dobry.",
				startMs: undefined,
				endMs: undefined,
			},
			{
				speaker: "Speaker B",
				text: "Witam.",
				startMs: undefined,
				endMs: undefined,
			},
		]);
	});
});

describe("DeepgramSttProvider — error mapping", () => {
	it.each([
		[401, "auth"],
		[403, "auth"],
		[429, "rate_limited"],
		[500, "transport"],
		[503, "transport"],
		[400, "invalid_response"],
	])("HTTP %i → ProviderError code '%s'", async (status, code) => {
		fetchMock.mockResolvedValue(new Response("error body", { status }));

		const promise = new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code });
	});

	it("network rejection → transport", async () => {
		fetchMock.mockRejectedValue(new TypeError("network down"));

		const promise = new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});
		await expect(promise).rejects.toMatchObject({ code: "transport" });
	});

	it("unparseable JSON → invalid_response", async () => {
		fetchMock.mockResolvedValue(new Response("<<not json>>", { status: 200 }));

		const promise = new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("empty channels array → invalid_response", async () => {
		fetchMock.mockResolvedValue(deepgramJson({ results: { channels: [] } }));

		const promise = new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("all channels empty → invalid_response", async () => {
		fetchMock.mockResolvedValue(
			deepgramJson({
				results: {
					channels: [
						{ alternatives: [{ transcript: "" }] },
						{ alternatives: [{ transcript: "  " }] },
					],
				},
			}),
		);

		const promise = new DeepgramSttProvider().transcribe({
			audio: streamSource(),
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("a url-kind source is a wiring bug → invalid_response (Deepgram only consumes a stream)", async () => {
		const promise = new DeepgramSttProvider().transcribe({
			audio: { kind: "url", url: "https://example/recording.wav" },
		});
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("DeepgramSttProvider — F3 abort-reason propagation", () => {
	it("re-throws the ProviderError carried on signal.reason (bridge mid-stream failure)", async () => {
		const ac = new AbortController();
		const reason = new ProviderError({
			code: "transport",
			message: "Twilio recording pull failed mid-stream",
		});
		ac.abort(reason);
		// fetch on an aborted signal rejects with a generic AbortError, NOT the
		// reason — the provider must recover the ProviderError from signal.reason.
		fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));

		const promise = new DeepgramSttProvider().transcribe({
			audio: streamSource({ signal: ac.signal }),
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({
			code: "transport",
			message: "Twilio recording pull failed mid-stream",
		});
	});
});
