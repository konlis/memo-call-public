import { z } from "zod";

import { ProviderError } from "~/server/_lib/provider-error";
import type {
	AudioSource,
	SttProvider,
	TranscriptResult,
	TranscriptSegment,
} from "~/server/stt/types";

// Direct process.env read (NOT through ~/env) — same rationale as the LLM mock:
// @t3-oss/env-nextjs caches the parsed env at module import, so tests mutating
// process.env.MOCK_STT_FORCE_ERROR mid-run would be invisible if we read it
// through `env`. The env.js entry is kept for build-time validation only.
const forceErrorSchema = z
	.enum(["transport", "rate_limited", "auth", "invalid_response"])
	.optional();

const shortTranscript: TranscriptSegment[] = [
	{
		speaker: "Speaker A",
		text: "Cześć, dzwonię w sprawie naszej rozmowy o demo.",
		startMs: 0,
		endMs: 3500,
	},
	{
		speaker: "Speaker B",
		text: "Tak, dzień dobry. O której godzinie panu pasuje?",
		startMs: 3500,
		endMs: 7200,
	},
	{
		speaker: "Speaker A",
		text: "Najlepiej w piątek o czternastej.",
		startMs: 7200,
		endMs: 9800,
	},
];

const longTranscript: TranscriptSegment[] = [
	{
		speaker: "Speaker A",
		text: "Dzień dobry, dzwonię z kontynuacji naszej rozmowy z poniedziałku.",
		startMs: 0,
		endMs: 4500,
	},
	{
		speaker: "Speaker B",
		text: "Tak, pamiętam. Czy udało się przygotować ofertę?",
		startMs: 4500,
		endMs: 7800,
	},
	{
		speaker: "Speaker A",
		text: "Tak, mamy gotowy mockup integracji CRM.",
		startMs: 7800,
		endMs: 10500,
	},
	{
		speaker: "Speaker B",
		text: "Świetnie, jak wygląda harmonogram wdrożenia?",
		startMs: 10500,
		endMs: 13800,
	},
	{
		speaker: "Speaker A",
		text: "Proponujemy start w Q3, finalizacja w Q4.",
		startMs: 13800,
		endMs: 17000,
	},
	{
		speaker: "Speaker B",
		text: "Budżet na Q3 jest potwierdzony.",
		startMs: 17000,
		endMs: 19500,
	},
	{
		speaker: "Speaker A",
		text: "Doskonale. Czy są jakieś dodatkowe wymagania?",
		startMs: 19500,
		endMs: 22800,
	},
	{
		speaker: "Speaker B",
		text: "Potrzebujemy raportu zgodności RODO.",
		startMs: 22800,
		endMs: 25500,
	},
	{
		speaker: "Speaker A",
		text: "Oczywiście, dołączymy go do dokumentacji.",
		startMs: 25500,
		endMs: 28500,
	},
	{
		speaker: "Speaker B",
		text: "Kiedy możemy podpisać umowę?",
		startMs: 28500,
		endMs: 31000,
	},
	{
		speaker: "Speaker A",
		text: "Mogę przygotować draft do środy.",
		startMs: 31000,
		endMs: 33500,
	},
	{
		speaker: "Speaker B",
		text: "Idealnie, dziękuję za rozmowę.",
		startMs: 33500,
		endMs: 36000,
	},
];

function deriveDuration(segments: TranscriptSegment[]): number {
	const last = segments[segments.length - 1];
	return last?.endMs ?? segments.length * 3000;
}

export class MockSttProvider implements SttProvider {
	async transcribe(input: {
		audio: AudioSource;
		language?: string;
	}): Promise<TranscriptResult> {
		const parsedForce = forceErrorSchema.safeParse(
			process.env.MOCK_STT_FORCE_ERROR,
		);
		if (!parsedForce.success) {
			throw new ProviderError({
				code: "unknown",
				message: "invalid MOCK_STT_FORCE_ERROR value",
			});
		}
		if (parsedForce.data) {
			throw new ProviderError({
				code: parsedForce.data,
				message: "forced via MOCK_STT_FORCE_ERROR",
			});
		}

		const segments = this.resolveSegments(input.audio);

		return {
			segments,
			language: input.language ?? "pl-PL",
			durationMs: deriveDuration(segments),
		};
	}

	/**
	 * Pick the canned transcript by audio source. A `stream`-kind source (the real
	 * Twilio→provider bridge transport) returns the long transcript so the worker's
	 * stream path is exercisable in mock mode without real bytes. A `url`-kind
	 * source keeps the `mock://short|long` sentinel behavior; any non-`mock://`
	 * URL is a misconfiguration → loud `invalid_response`.
	 */
	private resolveSegments(audio: AudioSource): TranscriptSegment[] {
		if (audio.kind === "stream") {
			return longTranscript;
		}
		if (!audio.url.startsWith("mock://")) {
			throw new ProviderError({
				code: "invalid_response",
				message: "MockSttProvider only handles mock:// URLs",
			});
		}
		return audio.url.startsWith("mock://long")
			? longTranscript
			: shortTranscript;
	}
}
