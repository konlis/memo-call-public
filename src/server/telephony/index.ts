import { env } from "~/env";
import { ProviderError } from "~/server/_lib/provider-error";
import { MockTelephonyProvider } from "~/server/telephony/mock";
import { TwilioTelephonyProvider } from "~/server/telephony/twilio";
import type { TelephonyProvider } from "~/server/telephony/types";
import { ZadarmaTelephonyProvider } from "~/server/telephony/zadarma";

function createTelephony(): TelephonyProvider {
	switch (env.TELEPHONY_PROVIDER) {
		case "mock":
			// `TELEPHONY_PROVIDER` is the one provider enum whose default is an
			// AUTHORIZATION decision, not a functional one: MockTelephonyProvider's
			// verifySignature returns true unconditionally, and `proxy.ts` excludes
			// `/api/telephony/*` from the auth gate because the signature IS the auth.
			// A typo in the secret fails loud at the zod enum; its ABSENCE would not
			// — the enum defaults to "mock", the Machine boots healthy, and both
			// webhooks start accepting unsigned POSTs from anyone. Refuse instead,
			// so a missing secret crashes boot → Fly rolls back. Mirrors the
			// PUBLIC_BASE_URL guard on the twilio branch below.
			//
			// Scoped to a real production RUNTIME. `next build` also runs with
			// NODE_ENV=production and evaluates this module (the tRPC routers import
			// the barrel statically), so gating on NODE_ENV alone would break the
			// build; NEXT_PHASE is set only while building.
			if (
				env.NODE_ENV === "production" &&
				process.env.NEXT_PHASE !== "phase-production-build"
			) {
				throw new ProviderError({
					code: "auth",
					message:
						"telephony provider 'mock' refused in production — set TELEPHONY_PROVIDER (the mock accepts every webhook signature)",
				});
			}
			return new MockTelephonyProvider();
		case "twilio": {
			// PUBLIC_BASE_URL is not a Twilio credential, but the webhook handlers
			// need it to reconstruct the signed external URL behind Fly's proxy.
			// Without it, signature reconstruction silently falls back to the
			// internal request origin and EVERY webhook 403s. Guard here — the
			// point where "real telephony ⇒ a public base URL is required" is
			// decided — so a misconfigured deploy fails loud at boot (→ Fly
			// rollback) instead of 403-ing every live call. Mirrors the provider's
			// own missing-credential guard below.
			if (!env.PUBLIC_BASE_URL) {
				throw new ProviderError({
					code: "auth",
					message:
						"telephony provider 'twilio' requires PUBLIC_BASE_URL (signed-webhook URL reconstruction behind the Fly proxy)",
				});
			}
			// Unlike the STT/LLM real branches (which throw at the switch until
			// S-01 wires them), the Twilio provider is implemented now. It throws
			// ProviderError({code:'auth'}) from its OWN constructor if any
			// required env (account sid / auth token / forward number) is missing
			// — still loud-at-startup, never a silent fallback to mock.
			return new TwilioTelephonyProvider({
				accountSid: env.TWILIO_ACCOUNT_SID,
				authToken: env.TWILIO_AUTH_TOKEN,
				region: env.TWILIO_REGION,
				edge: env.TWILIO_EDGE,
				forwardNumber: env.USER_FORWARD_NUMBER,
				// Outbound-only DID. Not validated here or at construction (inbound
				// must boot without it — F1); placeCall validates it lazily.
				callerId: env.TWILIO_CALLER_ID,
			});
		}
		case "zadarma":
			// NO `PUBLIC_BASE_URL` GUARD HERE, and its absence next to the twilio
			// branch above is a decision, not an omission. Twilio's HMAC covers the
			// full external URL, so without a public origin every Twilio webhook
			// 403s — hence the guard there. Zadarma signs only the concatenated body
			// fields and takes its notification URL from its own panel; we never send
			// it one (`recordingStatusCallbackUrl` is a silent no-op for this
			// provider). `calls.placeOutbound` does need `PUBLIC_BASE_URL`, but it
			// carries its OWN guard (`calls.ts:44-49`) — copying the twilio condition
			// here would block the INBOUND path from booting over a secret only
			// OUTBOUND needs, which is exactly the mistake avoided for
			// `TWILIO_CALLER_ID` (lazy validation, F1).
			//
			// Same fail-loud contract as the twilio branch: the provider's own
			// constructor throws `ProviderError({code:'auth'})` when the user key,
			// secret or forward number is missing — never a silent fallback to mock.
			// `ZADARMA_SIP_EXTENSION` is outbound-only and validated lazily inside
			// `placeCall`, so a missing one does NOT crash the inbound path.
			return new ZadarmaTelephonyProvider({
				userKey: env.ZADARMA_USER_KEY,
				secret: env.ZADARMA_SECRET,
				forwardNumber: env.USER_FORWARD_NUMBER,
				sipExtension: env.ZADARMA_SIP_EXTENSION,
			});
	}
}

// TODO(S-01+): cache on globalThis once the real provider holds connection
// state worth preserving across HMR — mirror db/index.ts. Mock + the current
// stateless Twilio REST wrapper are cheap to re-create, so a plain const is fine.
export const telephony: TelephonyProvider = createTelephony();

export type {
	RecordingEvent,
	TelephonyProvider,
	WebhookSignatureInput,
} from "~/server/telephony/types";
