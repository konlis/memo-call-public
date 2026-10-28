import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import { MockSttProvider } from "~/server/stt/mock";

describe("MockSttProvider", () => {
	const stt = new MockSttProvider();

	it("returns a Polish transcript with ≥2 distinct speakers for a mock://short url source", async () => {
		const result = await stt.transcribe({
			audio: { kind: "url", url: "mock://short" },
		});

		expect(result.language).toBe("pl-PL");
		expect(result.segments.length).toBeGreaterThanOrEqual(3);
		const speakers = new Set(result.segments.map((s) => s.speaker));
		expect(speakers.size).toBeGreaterThanOrEqual(2);
		expect(result.durationMs ?? 0).toBeGreaterThan(0);
	});

	it("returns the long canned transcript for a stream source (worker bridge path)", async () => {
		const result = await stt.transcribe({
			audio: { kind: "stream", open: () => new ReadableStream<Uint8Array>() },
		});

		expect(result.language).toBe("pl-PL");
		const speakers = new Set(result.segments.map((s) => s.speaker));
		expect(speakers.size).toBeGreaterThanOrEqual(2);
		expect(result.durationMs ?? 0).toBeGreaterThan(0);
	});

	it("throws ProviderError(invalid_response) for non-mock:// url sources", async () => {
		const promise = stt.transcribe({
			audio: {
				kind: "url",
				url: "https://real-twilio.example/recording.wav",
			},
		});
		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
	});

	describe("with MOCK_STT_FORCE_ERROR=transport", () => {
		const original = process.env.MOCK_STT_FORCE_ERROR;
		beforeEach(() => {
			process.env.MOCK_STT_FORCE_ERROR = "transport";
		});
		afterEach(() => {
			if (original === undefined) {
				delete process.env.MOCK_STT_FORCE_ERROR;
			} else {
				process.env.MOCK_STT_FORCE_ERROR = original;
			}
		});

		it("throws ProviderError with code 'transport'", async () => {
			const promise = stt.transcribe({
				audio: { kind: "url", url: "mock://short" },
			});
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "transport" });
		});
	});

	describe("with MOCK_STT_FORCE_ERROR set to an invalid value (typo path)", () => {
		const original = process.env.MOCK_STT_FORCE_ERROR;
		beforeEach(() => {
			process.env.MOCK_STT_FORCE_ERROR = "transprt";
		});
		afterEach(() => {
			if (original === undefined) {
				delete process.env.MOCK_STT_FORCE_ERROR;
			} else {
				process.env.MOCK_STT_FORCE_ERROR = original;
			}
		});

		it("throws ProviderError with code 'unknown' (fail-loud, not silent fallthrough)", async () => {
			const promise = stt.transcribe({
				audio: { kind: "url", url: "mock://short" },
			});
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "unknown" });
		});
	});
});
