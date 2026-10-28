import { describe, expect, test } from "vitest";

import {
	buildEventsWebhookUrl,
	buildSecretCommands,
	buildVoiceWebhookUrl,
	buildWebhookInstructions,
	isStereoCapableRecordStore,
	requiredKeys,
	validateConfig,
} from "./lib.mjs";

// A fully-valid sample config. Each rejecting case below clones this and
// corrupts exactly one field, so the asserted error is unambiguously that
// field's rule (not a presence error bleeding in from elsewhere).
//
// Kept on the TWILIO branch so the pre-existing assertions keep testing what
// they were written to test; the Zadarma branch gets its own fixture below.
const VALID = {
	TELEPHONY_PROVIDER: "twilio",
	DATABASE_URL: "file:/data/db.sqlite",
	AUTH_SECRET: "a".repeat(64),
	AUTH_URL: "https://your-app.fly.dev",
	DEEPGRAM_API_KEY: "dg-key-abc123",
	AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
	AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	AWS_REGION: "eu-central-1",
	BEDROCK_MODEL_ID: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
	TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
	TWILIO_AUTH_TOKEN: "twilio-token",
	USER_FORWARD_NUMBER: "+48512345678",
	TWILIO_CALLER_ID: "+48221234567",
	PUBLIC_BASE_URL: "https://your-app.fly.dev",
};

// The Zadarma branch: same common keys, different telephony triple, and NO
// Twilio keys at all — their absence must not be an error.
const VALID_ZADARMA = {
	TELEPHONY_PROVIDER: "zadarma",
	DATABASE_URL: "file:/data/db.sqlite",
	AUTH_SECRET: "a".repeat(64),
	AUTH_URL: "https://your-app.fly.dev",
	DEEPGRAM_API_KEY: "dg-key-abc123",
	AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
	AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	AWS_REGION: "eu-central-1",
	BEDROCK_MODEL_ID: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
	ZADARMA_USER_KEY: "zadarma-user-key",
	ZADARMA_SECRET: "zadarma-secret",
	ZADARMA_SIP_EXTENSION: "100",
	USER_FORWARD_NUMBER: "+48512345678",
	PUBLIC_BASE_URL: "https://your-app.fly.dev",
};

describe("validateConfig", () => {
	test("accepts a fully-valid config", () => {
		const { ok, errors } = validateConfig(VALID);
		expect(errors).toEqual([]);
		expect(ok).toBe(true);
	});

	// Each EU-residency + format footgun has a NAMED rejecting case.
	test.each([
		{
			name: "DATABASE_URL not file:",
			field: "DATABASE_URL",
			value: "postgres://x",
		},
		{
			name: "AUTH_SECRET too short",
			field: "AUTH_SECRET",
			value: "short-secret",
		},
		{
			name: "AUTH_URL trailing slash",
			field: "AUTH_URL",
			value: "https://your-app.fly.dev/",
		},
		{
			name: "AUTH_URL with path",
			field: "AUTH_URL",
			value: "https://your-app.fly.dev/login",
		},
		{
			name: "AUTH_URL http (not https)",
			field: "AUTH_URL",
			value: "http://your-app.fly.dev",
		},
		{
			name: "AWS_REGION not eu-central-1",
			field: "AWS_REGION",
			value: "us-east-1",
		},
		{
			name: "BEDROCK_MODEL_ID Global profile",
			field: "BEDROCK_MODEL_ID",
			value: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
		},
		{
			name: "DEEPGRAM_STT_HOST non-EU host",
			field: "DEEPGRAM_STT_HOST",
			value: "api.deepgram.com",
		},
		{
			name: "USER_FORWARD_NUMBER missing +",
			field: "USER_FORWARD_NUMBER",
			value: "48512345678",
		},
		{
			name: "TWILIO_CALLER_ID 00-prefixed",
			field: "TWILIO_CALLER_ID",
			value: "0048221234567",
		},
		{
			name: "TWILIO_ACCOUNT_SID API-key prefix",
			field: "TWILIO_ACCOUNT_SID",
			value: "SKxxxx",
		},
		{
			name: "PUBLIC_BASE_URL not https",
			field: "PUBLIC_BASE_URL",
			value: "http://your-app.fly.dev",
		},
	])("rejects: $name", ({ field, value }) => {
		const { ok, errors } = validateConfig({ ...VALID, [field]: value });
		expect(ok).toBe(false);
		expect(errors.map((e) => e.field)).toContain(field);
	});

	test("reports a presence error for a missing required key", () => {
		const { ok, errors } = validateConfig({ ...VALID, DEEPGRAM_API_KEY: "" });
		expect(ok).toBe(false);
		expect(errors.map((e) => e.field)).toContain("DEEPGRAM_API_KEY");
	});

	test("accepts the EU Deepgram host when explicitly set", () => {
		const { ok } = validateConfig({
			...VALID,
			DEEPGRAM_STT_HOST: "api.eu.deepgram.com",
		});
		expect(ok).toBe(true);
	});

	test("accepts when optional Deepgram host/model are absent", () => {
		const cfg = { ...VALID };
		delete (cfg as Record<string, string>).DEEPGRAM_STT_HOST;
		delete (cfg as Record<string, string>).DEEPGRAM_MODEL;
		expect(validateConfig(cfg).ok).toBe(true);
	});
});

describe("telephony provider selection", () => {
	test("accepts a fully-valid Zadarma config", () => {
		const { ok, errors } = validateConfig(VALID_ZADARMA);
		expect(errors).toEqual([]);
		expect(ok).toBe(true);
	});

	// The whole point of FU-5: a Zadarma operator must not be asked for Twilio
	// credentials that do not exist for them (and vice versa).
	test("does not require Twilio keys on the Zadarma branch", () => {
		const keys = requiredKeys(VALID_ZADARMA);
		expect(keys).toContain("ZADARMA_USER_KEY");
		expect(keys).not.toContain("TWILIO_ACCOUNT_SID");
		expect(keys).not.toContain("TWILIO_CALLER_ID");
	});

	test("does not require Zadarma keys on the Twilio branch", () => {
		const keys = requiredKeys(VALID);
		expect(keys).toContain("TWILIO_ACCOUNT_SID");
		expect(keys).not.toContain("ZADARMA_USER_KEY");
		expect(keys).not.toContain("ZADARMA_SIP_EXTENSION");
	});

	test("rejects a missing TELEPHONY_PROVIDER instead of defaulting", () => {
		// A silent default is the exact defect this change removes: the tool used
		// to print `TELEPHONY_PROVIDER=twilio` unconditionally.
		const cfg = { ...VALID_ZADARMA, TELEPHONY_PROVIDER: "" };
		const { ok, errors } = validateConfig(cfg);
		expect(ok).toBe(false);
		expect(errors.map((e) => e.field)).toContain("TELEPHONY_PROVIDER");
	});

	test("rejects an unknown provider, including mock", () => {
		for (const value of ["mock", "vonage", "Twilio"]) {
			const { ok, errors } = validateConfig({
				...VALID_ZADARMA,
				TELEPHONY_PROVIDER: value,
			});
			expect(ok).toBe(false);
			expect(errors.map((e) => e.field)).toContain("TELEPHONY_PROVIDER");
		}
	});

	test("an unknown provider does not bury its own error under phantom presence errors", () => {
		const { errors } = validateConfig({
			...VALID_ZADARMA,
			TELEPHONY_PROVIDER: "vonage",
		});
		// Only the enum error — no TWILIO_*/ZADARMA_* presence noise for a
		// provider nobody selected.
		expect(errors.map((e) => e.field)).toEqual(["TELEPHONY_PROVIDER"]);
	});

	test("reports a missing Zadarma credential", () => {
		const { ok, errors } = validateConfig({
			...VALID_ZADARMA,
			ZADARMA_SECRET: "",
		});
		expect(ok).toBe(false);
		expect(errors.map((e) => e.field)).toContain("ZADARMA_SECRET");
	});
});

describe("ZADARMA_SIP_EXTENSION shape", () => {
	// A wrong value returns NO error from the vendor — the call is placed and
	// simply is not recorded. That silence is why this validator exists.
	test.each([
		{ name: "SIP login (pbx-ext)", value: "123456-100" },
		{ name: "PBX id (6 digits)", value: "123456" },
		{ name: "extension with whitespace inside", value: "1 00" },
		{ name: "non-numeric", value: "ext100" },
		{ name: "plus-prefixed number", value: "+48512345678" },
	])("rejects: $name", ({ value }) => {
		const { ok, errors } = validateConfig({
			...VALID_ZADARMA,
			ZADARMA_SIP_EXTENSION: value,
		});
		expect(ok).toBe(false);
		expect(errors.map((e) => e.field)).toContain("ZADARMA_SIP_EXTENSION");
	});

	test.each([
		"100",
		"101",
		"1",
		"9999",
	])("accepts a bare extension: %s", (value) => {
		const { ok } = validateConfig({
			...VALID_ZADARMA,
			ZADARMA_SIP_EXTENSION: value,
		});
		expect(ok).toBe(true);
	});
});

describe("buildSecretCommands — Zadarma branch", () => {
	const cmds = buildSecretCommands(VALID_ZADARMA);
	const idxOf = (needle: string) => cmds.findIndex((c) => c.includes(needle));

	test("emits TELEPHONY_PROVIDER=zadarma, never twilio", () => {
		const joined = cmds.join("\n");
		expect(joined).toContain("TELEPHONY_PROVIDER='zadarma'");
		expect(joined).not.toContain("TELEPHONY_PROVIDER='twilio'");
	});

	// Deliberately built from a config carrying BOTH credential sets — the
	// realistic case of an operator reusing an old `.env.onboard.local`. Asserting
	// this against VALID_ZADARMA (which has no TWILIO_* keys) would pass even with
	// the provider branch removed, because `flyCmd` drops empty values: the test
	// would be measuring the fixture, not the builder. Verified by mutation.
	test("leaks no Twilio credential even when the config still carries them", () => {
		const polluted = {
			...VALID_ZADARMA,
			TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
			TWILIO_AUTH_TOKEN: "twilio-token",
			TWILIO_CALLER_ID: "+48221234567",
		};
		const joined = buildSecretCommands(polluted).join("\n");
		expect(joined).toContain("TELEPHONY_PROVIDER='zadarma'");
		expect(joined).not.toContain("TWILIO_ACCOUNT_SID");
		expect(joined).not.toContain("TWILIO_AUTH_TOKEN");
		expect(joined).not.toContain("TWILIO_CALLER_ID");
	});

	test("the provider flip comes AFTER the Zadarma credentials", () => {
		expect(idxOf("ZADARMA_SECRET")).toBeLessThan(idxOf("TELEPHONY_PROVIDER"));
		expect(idxOf("ZADARMA_USER_KEY")).toBeLessThan(idxOf("TELEPHONY_PROVIDER"));
	});

	test("the flip is its own standalone command", () => {
		const flip = cmds.find((c) => c.includes("TELEPHONY_PROVIDER"));
		expect(flip).toBe("fly secrets set TELEPHONY_PROVIDER='zadarma'");
	});

	test("carries the bare extension, the GSM number and the public origin", () => {
		const creds = cmds[idxOf("ZADARMA_SECRET")] as string;
		expect(creds).toContain("ZADARMA_SIP_EXTENSION='100'");
		expect(creds).toContain("USER_FORWARD_NUMBER='+48512345678'");
		expect(creds).toContain("PUBLIC_BASE_URL='https://your-app.fly.dev'");
	});
});

describe("buildWebhookInstructions", () => {
	test("Zadarma points at the account-level events URL", () => {
		const { url, lines } = buildWebhookInstructions(VALID_ZADARMA);
		expect(url).toBe("https://your-app.fly.dev/api/telephony/events");
		expect(lines.join("\n")).toContain("zd_echo");
	});

	test("Zadarma states the forbidden speech_recognition=off state", () => {
		const { lines } = buildWebhookInstructions(VALID_ZADARMA);
		const text = lines.join("\n");
		expect(text).toContain("speech_recognition = off");
		expect(text).toContain("STEREO");
	});

	test("Zadarma states BOTH inbound-routing links", () => {
		// The chain breaks at two independent places and neither is visible in a
		// single API read — omitting one produces a busy signal with every probe
		// green (handoff.md, 2026-09-05).
		const text = buildWebhookInstructions(VALID_ZADARMA).lines.join("\n");
		expect(text).toContain("destination=pbx");
		expect(text).toContain("scenariusz");
	});

	test("Zadarma tells the operator the instance stores caller numbers and names (FR-025)", () => {
		// Pre-mortem #10: a fleet operator must learn this at setup, not from the
		// panel weeks later. Kept out of the copy-paste block on purpose.
		const text = buildWebhookInstructions(VALID_ZADARMA).lines.join("\n");
		expect(text).toContain(
			"przechowuje numer i nazwę prezentacji rozmówcy podane przez operatora",
		);
		expect(text).toContain("04-privacy-and-anonymity.md");
	});

	test("Twilio points at the renamed voice route, never the dead one", () => {
		const { url, lines } = buildWebhookInstructions(VALID);
		expect(url).toBe("https://your-app.fly.dev/api/telephony/voice");
		expect(lines.join("\n")).not.toContain("<tunnel>");
		expect(url).not.toContain("/api/twilio/");
	});

	test("no builder ever emits the pre-rename /api/twilio path", () => {
		expect(buildVoiceWebhookUrl(VALID)).not.toContain("/api/twilio/");
		expect(buildEventsWebhookUrl(VALID_ZADARMA)).not.toContain("/api/twilio/");
	});

	test("tolerates a trailing slash on PUBLIC_BASE_URL (events URL)", () => {
		const url = buildEventsWebhookUrl({
			...VALID_ZADARMA,
			PUBLIC_BASE_URL: "https://your-app.fly.dev/",
		});
		expect(url).toBe("https://your-app.fly.dev/api/telephony/events");
	});
});

/**
 * Findings from the /code-review of the FU commits (2026-09-07). All three were
 * confirmed against the evidence before being fixed; each gets a test naming the
 * scenario, because all three are silent in normal operation.
 */
describe("record_store → stereo predicate (review F1)", () => {
	test("accepts the ONE measured stereo value", () => {
		// `GET /v1/pbx/internal/100/info/`, 2026-09-05, on the account whose four
		// recordings passed the stereo gate (handoff.md:199).
		expect(isStereoCapableRecordStore("For manual recognition")).toBe(true);
	});

	test.each([
		"W chmurę",
		"W chmurze",
		"In the cloud",
		"To the cloud",
		"Cloud storage",
	])("REFUSES the storage-destination value %s", (value) => {
		// THE finding. `„W chmurę"` is the panel's recording STORAGE DESTINATION
		// (handoff.md:324), not the speech-recognition setting — and it stays ON in
		// the forbidden `speech_recognition=off` state, where recordings become
		// mono 8 kHz mp3. The first version of the allowlist carried `chmur|cloud`,
		// so it would have answered "✅ stereo" for exactly the configuration the
		// probe exists to catch, while `zadarma.ts` kept announcing `audio/ogg` to
		// Deepgram and speaker separation silently disappeared.
		expect(isStereoCapableRecordStore(value)).toBe(false);
	});

	test.each([
		"",
		"   ",
		"Off",
		"Disabled",
		"Wyłączone",
		"unknown-future-string",
	])("REFUSES the unmeasured value %s", (value) => {
		// Fail-closed: the string the vendor returns for `off` has never been
		// observed, so anything not on the measured list is a rejection.
		expect(isStereoCapableRecordStore(value)).toBe(false);
	});

	test("refuses null/undefined without throwing", () => {
		expect(isStereoCapableRecordStore(undefined)).toBe(false);
		expect(isStereoCapableRecordStore(null)).toBe(false);
	});
});

describe("provider lookup is own-property only (review F2)", () => {
	test.each([
		"constructor",
		"toString",
		"valueOf",
		"hasOwnProperty",
		"__proto__",
	])("does not inherit from Object.prototype for %s", (provider) => {
		// A plain object literal inherits these, so `TELEPHONY_KEYS[provider] ?? []`
		// resolved to a non-null NON-ARRAY and the spread threw
		// `TypeError: extra is not iterable` — inside readConfig(), before
		// validateConfig ran, so a typo'd provider produced a stack trace instead of
		// the enum message.
		expect(() => requiredKeys({ TELEPHONY_PROVIDER: provider })).not.toThrow();
		expect(requiredKeys({ TELEPHONY_PROVIDER: provider })).not.toContain(
			"TWILIO_ACCOUNT_SID",
		);
	});

	test("an unknown provider still reports as an enum error, not a crash", () => {
		const { ok, errors } = validateConfig({
			...VALID_ZADARMA,
			TELEPHONY_PROVIDER: "constructor",
		});
		expect(ok).toBe(false);
		expect(errors.map((e) => e.field)).toEqual(["TELEPHONY_PROVIDER"]);
	});
});

describe("provider dispatch is exhaustive (review F3)", () => {
	// The FU-5 defect recurring: `if (zadarma) … else <twilio>` means a third
	// vendor added the documented way (a value in TELEPHONY_PROVIDERS + an entry
	// in TELEPHONY_KEYS) silently gets the TWILIO block — credentials, flip and
	// console steps — under the full "Konfiguracja poprawna ✅" ceremony.
	const future = { ...VALID_ZADARMA, TELEPHONY_PROVIDER: "vonage" };

	test("buildSecretCommands throws rather than emitting Twilio", () => {
		expect(() => buildSecretCommands(future)).toThrow(/vonage/);
	});

	test("buildWebhookInstructions throws rather than printing Twilio steps", () => {
		expect(() => buildWebhookInstructions(future)).toThrow(/vonage/);
	});

	test("the error names every place a new provider must be registered", () => {
		// An exhaustiveness guard is only useful if it says what to do next.
		let message = "";
		try {
			buildSecretCommands(future);
		} catch (err) {
			message = String((err as Error).message);
		}
		expect(message).toContain("TELEPHONY_PROVIDERS");
		expect(message).toContain("TELEPHONY_KEYS");
		expect(message).toContain("buildWebhookInstructions");
	});

	test("both known providers still dispatch correctly", () => {
		expect(buildSecretCommands(VALID_ZADARMA).join("\n")).toContain(
			"TELEPHONY_PROVIDER='zadarma'",
		);
		expect(buildSecretCommands(VALID).join("\n")).toContain(
			"TELEPHONY_PROVIDER='twilio'",
		);
	});
});

describe("buildSecretCommands", () => {
	const cmds = buildSecretCommands(VALID);

	// Index of the FIRST command whose text contains the given substring.
	const idxOf = (needle: string) => cmds.findIndex((c) => c.includes(needle));

	test("emits boot-critical secrets first", () => {
		expect(cmds[0]).toContain("DATABASE_URL=");
		expect(cmds[0]).toContain("AUTH_SECRET=");
		expect(cmds[0]).toContain("AUTH_URL=");
	});

	test("STT_PROVIDER flip comes AFTER the Deepgram key", () => {
		expect(idxOf("DEEPGRAM_API_KEY=")).toBeGreaterThanOrEqual(0);
		expect(idxOf("STT_PROVIDER=")).toBeGreaterThan(idxOf("DEEPGRAM_API_KEY="));
	});

	test("LLM_PROVIDER flip comes AFTER the Bedrock creds", () => {
		expect(idxOf("BEDROCK_MODEL_ID=")).toBeGreaterThanOrEqual(0);
		expect(idxOf("LLM_PROVIDER=")).toBeGreaterThan(idxOf("BEDROCK_MODEL_ID="));
	});

	test("TELEPHONY_PROVIDER flip comes AFTER the Twilio creds", () => {
		expect(idxOf("TWILIO_ACCOUNT_SID=")).toBeGreaterThanOrEqual(0);
		expect(idxOf("TELEPHONY_PROVIDER=")).toBeGreaterThan(
			idxOf("TWILIO_ACCOUNT_SID="),
		);
	});

	test("each *_PROVIDER flip is its own standalone command", () => {
		// Values are single-quoted (paste-safe), so assert the quoted form.
		expect(cmds).toContain("fly secrets set STT_PROVIDER='deepgram'");
		expect(cmds).toContain("fly secrets set LLM_PROVIDER='anthropic-bedrock'");
		expect(cmds).toContain("fly secrets set TELEPHONY_PROVIDER='twilio'");
	});

	test("single-quotes each value so the command is paste-safe", () => {
		const cmd = buildSecretCommands({
			...VALID,
			// A value with a space + single quote would break an unquoted command.
			AUTH_SECRET: "correct horse battery o'staple padding to pass 32+",
		})[0];
		expect(cmd).toContain("AUTH_SECRET='correct horse battery o'\\''staple");
	});

	test("omits optional Deepgram host/model when absent", () => {
		const cfg = { ...VALID };
		delete (cfg as Record<string, string>).DEEPGRAM_STT_HOST;
		delete (cfg as Record<string, string>).DEEPGRAM_MODEL;
		const sttCmd = buildSecretCommands(cfg).find((c) =>
			c.includes("DEEPGRAM_API_KEY="),
		);
		expect(sttCmd).not.toContain("DEEPGRAM_STT_HOST=");
		expect(sttCmd).not.toContain("DEEPGRAM_MODEL=");
	});
});

describe("buildVoiceWebhookUrl", () => {
	test("joins PUBLIC_BASE_URL with the voice route", () => {
		expect(buildVoiceWebhookUrl(VALID)).toBe(
			"https://your-app.fly.dev/api/telephony/voice",
		);
	});

	test("tolerates a trailing slash on PUBLIC_BASE_URL", () => {
		expect(
			buildVoiceWebhookUrl({ PUBLIC_BASE_URL: "https://your-app.fly.dev/" }),
		).toBe("https://your-app.fly.dev/api/telephony/voice");
	});
});
