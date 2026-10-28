import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	/**
	 * Specify your server-side environment variables schema here. This way you can ensure the app
	 * isn't built with invalid env vars.
	 */
	server: {
		DATABASE_URL: z.string().url(),
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),
		AUTH_SECRET: z.string().min(
			32,
			// NOT `openssl rand -hex 32`, which this message used to name. On
			// 2026-09-07 `openssl` was absent on the operator's machine, the
			// shell substituted an EMPTY string, `fly secrets set` accepted it
			// without a word, and the Machine then died right here at boot —
			// ~10 minutes of production 500s whose only clue was this line.
			// `node` is guaranteed present wherever this project is operated.
			'AUTH_SECRET must be at least 32 chars — generate with `node -e \'console.log(require("crypto").randomBytes(32).toString("hex"))\'` and CHECK ITS LENGTH (64) before setting it',
		),
		LLM_PROVIDER: z.enum(["mock", "anthropic-bedrock"]).default("mock"),
		MOCK_LLM_FORCE_ERROR: z
			.enum([
				"transport",
				"rate_limited",
				"auth",
				"invalid_response",
				"refusal",
			])
			.optional(),
		// AWS Bedrock vars are `.optional()`: the provider validates all four at
		// construction (throws auth), so mock-mode builds need no AWS secrets. The
		// model id is the EU inference profile, e.g.
		// `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (EU-only routing).
		AWS_ACCESS_KEY_ID: z.string().optional(),
		AWS_SECRET_ACCESS_KEY: z.string().optional(),
		AWS_REGION: z.string().optional(),
		BEDROCK_MODEL_ID: z.string().optional(),
		STT_PROVIDER: z.enum(["mock", "google-cloud", "deepgram"]).default("mock"),
		MOCK_STT_FORCE_ERROR: z
			.enum(["transport", "rate_limited", "auth", "invalid_response"])
			.optional(),
		// Deepgram vars are `.optional()`: the provider validates the API key at
		// construction (throws auth), so mock-mode builds need no Deepgram secret.
		// Host/model carry defaults in the provider (api.eu.deepgram.com / nova-3).
		DEEPGRAM_API_KEY: z.string().optional(),
		DEEPGRAM_STT_HOST: z.string().optional(),
		DEEPGRAM_MODEL: z.string().optional(),
		TELEPHONY_PROVIDER: z.enum(["mock", "twilio", "zadarma"]).default("mock"),
		// Twilio vars are `.optional()`: the provider validates presence at
		// construction (throws auth), so mock-mode builds need no Twilio secrets.
		TWILIO_ACCOUNT_SID: z.string().optional(),
		TWILIO_AUTH_TOKEN: z.string().optional(),
		// Region/edge drive US1→IE1 portability; absent = US1 (api.twilio.com).
		TWILIO_REGION: z.string().optional(),
		TWILIO_EDGE: z.string().optional(),
		USER_FORWARD_NUMBER: z.string().optional(),
		// Outbound caller-id DID, used as `From` on click-to-call. `.optional()`:
		// it is an outbound-only credential validated lazily inside
		// `TwilioTelephonyProvider.placeCall` (throws auth), so inbound + mock-mode
		// boots need it not be set.
		TWILIO_CALLER_ID: z.string().optional(),
		// Zadarma vars are `.optional()` for the same reason as Twilio's: the
		// provider validates presence at construction (throws auth), so mock-mode
		// builds need no Zadarma secrets. `USER_FORWARD_NUMBER` is shared with the
		// Twilio branch and is NOT duplicated here.
		ZADARMA_USER_KEY: z.string().optional(),
		ZADARMA_SECRET: z.string().optional(),
		// The BARE PBX extension number (e.g. `100`) — NOT the SIP login
		// (`123456-100`) and NOT the PBX id (`123456`). This distinction has no
		// error path: a wrong value does not fail, it places the call and simply
		// does not record it. Measured 2026-09-05 — the PBX id "works" today only
		// because Zadarma falls through to the single active extension, so on an
		// account with two extensions the same typo stops being invisible and
		// starts recording the wrong one. Outbound-only, so it is validated
		// lazily inside `placeCall` (same shape as TWILIO_CALLER_ID), never at
		// construction.
		ZADARMA_SIP_EXTENSION: z.string().optional(),
		MOCK_TELEPHONY_FORCE_ERROR: z
			.enum(["transport", "rate_limited", "auth", "invalid_response"])
			.optional(),
		// Public origin used by the Twilio Route Handlers to reconstruct the
		// signed external URL behind Fly's proxy (Phase 3). Optional in mock mode.
		PUBLIC_BASE_URL: z.string().url().optional(),
	},

	/**
	 * Specify your client-side environment variables schema here. This way you can ensure the app
	 * isn't built with invalid env vars. To expose them to the client, prefix them with
	 * `NEXT_PUBLIC_`.
	 */
	client: {
		// NEXT_PUBLIC_CLIENTVAR: z.string(),
	},

	/**
	 * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
	 * middlewares) or client-side so we need to destruct manually.
	 */
	runtimeEnv: {
		DATABASE_URL: process.env.DATABASE_URL,
		NODE_ENV: process.env.NODE_ENV,
		AUTH_SECRET: process.env.AUTH_SECRET,
		LLM_PROVIDER: process.env.LLM_PROVIDER,
		MOCK_LLM_FORCE_ERROR: process.env.MOCK_LLM_FORCE_ERROR,
		AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
		AWS_REGION: process.env.AWS_REGION,
		BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID,
		STT_PROVIDER: process.env.STT_PROVIDER,
		MOCK_STT_FORCE_ERROR: process.env.MOCK_STT_FORCE_ERROR,
		DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
		DEEPGRAM_STT_HOST: process.env.DEEPGRAM_STT_HOST,
		DEEPGRAM_MODEL: process.env.DEEPGRAM_MODEL,
		TELEPHONY_PROVIDER: process.env.TELEPHONY_PROVIDER,
		TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
		TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
		TWILIO_REGION: process.env.TWILIO_REGION,
		TWILIO_EDGE: process.env.TWILIO_EDGE,
		USER_FORWARD_NUMBER: process.env.USER_FORWARD_NUMBER,
		TWILIO_CALLER_ID: process.env.TWILIO_CALLER_ID,
		ZADARMA_USER_KEY: process.env.ZADARMA_USER_KEY,
		ZADARMA_SECRET: process.env.ZADARMA_SECRET,
		ZADARMA_SIP_EXTENSION: process.env.ZADARMA_SIP_EXTENSION,
		MOCK_TELEPHONY_FORCE_ERROR: process.env.MOCK_TELEPHONY_FORCE_ERROR,
		PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
		// NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,
	},
	/**
	 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
	 * useful for Docker builds.
	 */
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
	/**
	 * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
	 * `SOME_VAR=''` will throw an error.
	 */
	emptyStringAsUndefined: true,
});
