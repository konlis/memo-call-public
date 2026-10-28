import { env } from "~/env";
import { ProviderError } from "~/server/_lib/provider-error";
import { DeepgramSttProvider } from "~/server/stt/deepgram";
import { MockSttProvider } from "~/server/stt/mock";
import type { SttProvider } from "~/server/stt/types";

function createStt(): SttProvider {
	switch (env.STT_PROVIDER) {
		case "mock":
			return new MockSttProvider();
		case "deepgram":
			return new DeepgramSttProvider();
		case "google-cloud":
			throw new ProviderError({
				code: "auth",
				message: "google-cloud provider not implemented — wired in S-01",
			});
	}
}

// Cache the singleton on globalThis in non-production so HMR reloads don't
// re-run the (now real) provider constructor — mirrors the db/index.ts pattern.
// The Deepgram constructor reads + validates DEEPGRAM_API_KEY, so `deepgram`
// without a key throws `auth` at module load (loud fail, never a mock fallback).
const globalForStt = globalThis as unknown as {
	stt: SttProvider | undefined;
};

export const stt: SttProvider = globalForStt.stt ?? createStt();
if (env.NODE_ENV !== "production") globalForStt.stt = stt;

export type {
	SttProvider,
	TranscriptResult,
	TranscriptSegment,
} from "~/server/stt/types";
