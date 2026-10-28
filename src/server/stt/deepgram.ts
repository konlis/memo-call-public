import { env } from "~/env";
import { ProviderError } from "~/server/_lib/provider-error";
import type {
	AudioSource,
	SttProvider,
	TranscriptResult,
	TranscriptSegment,
} from "~/server/stt/types";

const DEFAULT_HOST = "api.eu.deepgram.com";
const DEFAULT_MODEL = "nova-3";

/**
 * Minimal view of the Deepgram pre-recorded response — only the fields we map.
 * `multichannel=true` returns one `channels[]` entry per audio channel, each with
 * its own `alternatives[0].transcript` + word timings. Validated in the Phase 1
 * spike (`scripts/spike/stt-bakeoff.mjs` + `spike.md`).
 */
type DeepgramWord = { start?: number; end?: number };
type DeepgramAlternative = { transcript?: string; words?: DeepgramWord[] };
type DeepgramChannel = { alternatives?: DeepgramAlternative[] };
/**
 * One time-ordered utterance from `utterances=true`. Under `multichannel=true`
 * each utterance carries the physical-channel index it came from, so the speaker
 * label stays keyed to the leg (no diarization guessing). Only the fields we map.
 */
type DeepgramUtterance = {
	channel?: number;
	start?: number;
	end?: number;
	transcript?: string;
};
type DeepgramResponse = {
	results?: { channels?: DeepgramChannel[]; utterances?: DeepgramUtterance[] };
	metadata?: { duration?: number };
};

// `duplex` is required by undici for a streaming request body but is absent from
// the DOM `RequestInit` type in our TS lib — intersect it in locally.
type StreamingRequestInit = RequestInit & { duplex: "half" };

function speakerLabel(channelIndex: number): string {
	// 0 → "Speaker A", 1 → "Speaker B", …
	return `Speaker ${String.fromCharCode(65 + channelIndex)}`;
}

/** Deepgram word offsets are seconds (float); we persist integer milliseconds. */
function secondsToMs(seconds: number | undefined): number | undefined {
	return typeof seconds === "number" ? Math.round(seconds * 1000) : undefined;
}

/**
 * Primary mapping: time-ordered utterances → interleaved dialogue turns. The
 * list is sorted by start time (channel index breaks ties), then CONSECUTIVE
 * utterances from the same physical channel are coalesced into a single turn.
 * Deepgram splits one speaker's continuous speech into a fresh utterance on every
 * silence gap (`utt_split`), so without coalescing a single monologue would
 * render as many run-on "Speaker X" fragments. A turn ends only when the OTHER
 * channel takes the floor — we assume the two legs don't interrupt each other; a
 * genuine mid-turn interjection just yields A/B/A, which is still correct and
 * readable. Merged text is space-joined; `startMs` comes from the first utterance
 * of the run, `endMs` from the last. Empty/blank utterances are skipped (a blank
 * between two same-channel turns is dropped first, so the run still merges).
 * Returns `[]` when `utterances` is absent so the caller can fall back.
 */
function mapUtterancesToSegments(
	utterances: DeepgramUtterance[] | undefined,
): TranscriptSegment[] {
	if (!Array.isArray(utterances)) return [];
	const ordered = utterances
		.filter((u) => (u.transcript ?? "").trim().length > 0)
		.sort(
			(a, b) =>
				(a.start ?? 0) - (b.start ?? 0) || (a.channel ?? 0) - (b.channel ?? 0),
		);

	const segments: TranscriptSegment[] = [];
	let currentChannel: number | null = null;
	for (const u of ordered) {
		const channel = u.channel ?? 0;
		const text = (u.transcript ?? "").trim();
		const endMs = secondsToMs(u.end);
		if (channel === currentChannel && segments.length > 0) {
			// Same speaker continuing after a pause — extend the open turn instead of
			// starting a new "Speaker X" line. Keep the run's first startMs; advance
			// endMs to this utterance's end (guard undefined so a missing end doesn't
			// clobber an earlier real value).
			const open = segments[segments.length - 1] as TranscriptSegment;
			open.text = `${open.text} ${text}`;
			if (endMs !== undefined) open.endMs = endMs;
		} else {
			segments.push({
				speaker: speakerLabel(channel),
				text,
				startMs: secondsToMs(u.start),
				endMs,
			});
			currentChannel = channel;
		}
	}
	return segments;
}

/**
 * Fallback mapping (pre-`utterances` behavior): one segment per non-empty
 * physical channel, timings from the first/last word of that channel. Used only
 * when Deepgram returns no `utterances` — preserves a usable transcript rather
 * than dead-lettering a real note.
 */
function mapChannelsToSegments(
	channels: DeepgramChannel[],
): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	channels.forEach((channel, channelIndex) => {
		const alt = channel.alternatives?.[0];
		const text = (alt?.transcript ?? "").trim();
		// Skip a silent leg (e.g. an unanswered/voicemail channel) rather than
		// persisting an empty "Speaker X: " line. Labels stay keyed to the
		// physical channel index so the surviving leg keeps its stable speaker.
		if (text.length === 0) return;
		const words = alt?.words ?? [];
		segments.push({
			speaker: speakerLabel(channelIndex),
			text,
			startMs: secondsToMs(words[0]?.start),
			endMs: secondsToMs(words[words.length - 1]?.end),
		});
	});
	return segments;
}

/**
 * Real STT provider: Deepgram Nova-3 on the EU endpoint, talked to via raw
 * `fetch` (no SDK — keeps the Docker image lean and gives full control of the
 * streaming request body). Consumes a `stream`-kind `AudioSource` as the POST
 * body and maps the time-ordered `results.utterances[]` to one `TranscriptSegment`
 * per coalesced speaker turn (consecutive same-channel utterances merged into one
 * interleaved-dialogue turn), falling back to one segment per non-empty channel
 * when no utterances are returned. All failures funnel through the shared
 * `ProviderError` discriminator so the job worker's retry/dead-letter switch
 * behaves identically to the mock.
 *
 * EU residency + zero-data-retention are product constraints (CLAUDE.md): the
 * host defaults to `api.eu.deepgram.com` and we never enable prompt logging.
 */
export class DeepgramSttProvider implements SttProvider {
	private readonly apiKey: string;
	private readonly host: string;
	private readonly model: string;

	constructor() {
		const key = env.DEEPGRAM_API_KEY;
		if (!key) {
			// Loud failure at construction, mirroring the Twilio/STT real-branch
			// pattern — never a silent fallback to mock.
			throw new ProviderError({
				code: "auth",
				message:
					"DEEPGRAM_API_KEY is required when STT_PROVIDER=deepgram (set it as a Fly secret)",
			});
		}
		this.apiKey = key;
		this.host = env.DEEPGRAM_STT_HOST ?? DEFAULT_HOST;
		this.model = env.DEEPGRAM_MODEL ?? DEFAULT_MODEL;
	}

	async transcribe(input: {
		audio: AudioSource;
		language?: string;
	}): Promise<TranscriptResult> {
		if (input.audio.kind !== "stream") {
			// Deepgram cannot fetch Twilio's Basic-auth media URL — the worker always
			// hands it a stream. A `url`-kind source here is a wiring bug.
			throw new ProviderError({
				code: "invalid_response",
				message: "DeepgramSttProvider requires a stream audio source",
			});
		}
		const audio = input.audio;

		// Truthiness guard (not `??`): an empty/blank `language` arg must fall back
		// too, else the Deepgram query degenerates to `language=` and we'd persist "".
		const requestedLanguage = input.language?.trim() || "pl-PL";
		// Deepgram expects the primary subtag ("pl"), validated in the spike — not
		// the BCP-47 region form ("pl-PL") the worker passes / we persist.
		const deepgramLanguage = requestedLanguage.split("-")[0] ?? "pl";

		const qs = new URLSearchParams({
			model: this.model,
			language: deepgramLanguage,
			multichannel: "true",
			// Time-ordered turns across channels. We prefer `results.utterances[]`
			// (interleaved dialogue) and fall back to per-channel mapping if absent.
			utterances: "true",
			punctuate: "true",
		});
		const url = `https://${this.host}/v1/listen?${qs.toString()}`;

		const init: StreamingRequestInit = {
			method: "POST",
			headers: {
				Authorization: `Token ${this.apiKey}`,
				"Content-Type": audio.contentType ?? "audio/wav",
			},
			body: audio.open(),
			// Presence of `duplex` is what makes undici send the body chunked (no
			// Content-Length) — the exact transport the Phase 1 spike proved (F1).
			duplex: "half",
			signal: audio.signal,
		};

		let res: Response;
		try {
			res = await fetch(url, init);
		} catch (cause) {
			// The bridge aborts the fetch with a ProviderError cause on a mid-stream
			// Twilio failure (worker F3) — surface that exact code, not a masked
			// generic "body aborted" → wrong `unknown` dead-letter.
			if (cause instanceof ProviderError) throw cause;
			if (audio.signal?.reason instanceof ProviderError) {
				throw audio.signal.reason;
			}
			throw new ProviderError({
				code: "transport",
				message: "Deepgram request failed",
				cause,
			});
		}

		if (!res.ok) {
			const bodyText = await res.text().catch(() => "");
			throw this.mapHttpError(res.status, bodyText);
		}

		let json: DeepgramResponse;
		try {
			json = (await res.json()) as DeepgramResponse;
		} catch (cause) {
			throw new ProviderError({
				code: "invalid_response",
				message: "Deepgram returned unparseable JSON",
				cause,
			});
		}

		const channels = json.results?.channels;
		if (!Array.isArray(channels) || channels.length === 0) {
			throw new ProviderError({
				code: "invalid_response",
				message: "Deepgram response carried no channels",
			});
		}

		// Prefer time-ordered utterances (interleaved dialogue); fall back to the
		// per-channel mapping when Deepgram returns no utterances so we never lose
		// a real note to an unexpected response shape.
		const utteranceSegments = mapUtterancesToSegments(json.results?.utterances);
		const segments =
			utteranceSegments.length > 0
				? utteranceSegments
				: mapChannelsToSegments(channels);

		if (segments.length === 0) {
			throw new ProviderError({
				code: "invalid_response",
				message: "Deepgram returned no non-empty channels",
			});
		}

		return {
			segments,
			// Deepgram does not echo the requested language when it is supplied, so
			// we report what we asked for (BCP-47, the form downstream persists).
			language: requestedLanguage,
			durationMs: secondsToMs(json.metadata?.duration),
		};
	}

	/** Map a non-2xx HTTP status to the shared ProviderError discriminator. */
	private mapHttpError(status: number, body: string): ProviderError {
		if (status === 401 || status === 403) {
			return new ProviderError({
				code: "auth",
				message: `Deepgram auth failed (${status})`,
			});
		}
		if (status === 429) {
			return new ProviderError({
				code: "rate_limited",
				message: "Deepgram rate limited (429)",
			});
		}
		if (status >= 500) {
			return new ProviderError({
				code: "transport",
				message: `Deepgram server error (${status})`,
			});
		}
		return new ProviderError({
			code: "invalid_response",
			message: `Deepgram returned ${status}: ${body.slice(0, 500)}`,
		});
	}
}
