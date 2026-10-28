export type TranscriptSegment = {
	speaker: string;
	text: string;
	startMs?: number;
	endMs?: number;
};

export type TranscriptResult = {
	segments: TranscriptSegment[];
	language: string;
	durationMs?: number;
};

/**
 * Where a provider gets the audio bytes. A discriminated union so the seam stays
 * vendor-agnostic across two transports:
 *
 * - `url`    — the provider fetches the audio itself (any future Google/Azure
 *              fallback that consumes a public/`gs://`/SAS URL; also the mock's
 *              `mock://` sentinel).
 * - `stream` — the caller supplies the bytes as a `ReadableStream` the provider
 *              pipes straight into its request body. This is the Deepgram path:
 *              Twilio media sits behind Basic-auth with no signed URL, so the
 *              worker bridges Twilio→Deepgram and never stages the file (constant
 *              RAM under the 256 MB Machine ceiling). `open()` is called once by
 *              the provider to obtain the body; `signal` lets the bridge abort the
 *              in-flight request on a mid-stream pull failure (worker F3).
 */
export type AudioSource =
	| { kind: "url"; url: string }
	| {
			kind: "stream";
			open: () => ReadableStream<Uint8Array>;
			contentType?: string;
			durationMsHint?: number;
			signal?: AbortSignal;
			/**
			 * Tear down the underlying byte source. The consumer (the job worker)
			 * calls this in a `finally` once `transcribe` settles — success OR error
			 * — so a provider that throws before draining the stream cannot leave the
			 * upstream pull stalled on backpressure (worker F1). Idempotent.
			 */
			cleanup?: () => void;
	  };

export interface SttProvider {
	transcribe(input: {
		audio: AudioSource;
		language?: string;
	}): Promise<TranscriptResult>;
}
