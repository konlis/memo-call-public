// Pure, side-effect-free core for the operator onboarding tool (deliverable #2
// of `operator-onboarding-tooling`). NO I/O here — no `fetch`, no `fly`, no
// `process.*`, no DB. Just validators and string/array builders, so the
// dangerous-to-get-wrong logic (EU-residency rules + `fly secrets set` ORDER)
// is unit-testable and the entrypoint (`scripts/onboard.mjs`) stays a thin
// shell. This is also the exact seam a future `--execute` mode would hook into
// (swap "return command string" for "spawn fly") without touching validators.
//
// Authority for the secret list + ordering: `src/env.js` (the enums + var
// names) and CLAUDE.md → "Production (Fly.io) → Required secrets".

/** The EU-pinned Deepgram host (data-residency hard constraint). */
export const DEEPGRAM_EU_HOST = "api.eu.deepgram.com";

/** The only AWS region allowed (EU residency; Bedrock Haiku 4.5). */
export const AWS_EU_REGION = "eu-central-1";

/** E.164: leading `+`, no leading zero, 7–15 total digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** Telephony providers this tool can onboard. Mirrors the `src/env.js` enum
 *  minus `mock`, which is refused in production by `createTelephony()`. */
export const TELEPHONY_PROVIDERS = ["zadarma", "twilio"];

/**
 * Required keys common to BOTH telephony providers.
 *
 * `TELEPHONY_PROVIDER` is required and has NO default here on purpose. It used
 * to be absent from the config entirely and hardcoded to `twilio` in the
 * command builder, which — after `telephony-provider-zadarma` — meant this tool
 * handed a new fleet instance the credential block of the provider the project
 * had just migrated OFF, with full "validated before anything is set" ceremony.
 * A silent default is exactly that failure mode with a nicer name, so the
 * operator states the provider or the tool refuses.
 */
const COMMON_KEYS = [
	"DATABASE_URL",
	"AUTH_SECRET",
	"AUTH_URL",
	"DEEPGRAM_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_REGION",
	"BEDROCK_MODEL_ID",
	"TELEPHONY_PROVIDER",
	"USER_FORWARD_NUMBER",
	"PUBLIC_BASE_URL",
];

/**
 * Required keys that exist only for one telephony provider.
 * @type {Record<string, string[]>}
 */
const TELEPHONY_KEYS = {
	twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_CALLER_ID"],
	zadarma: ["ZADARMA_USER_KEY", "ZADARMA_SECRET", "ZADARMA_SIP_EXTENSION"],
};

/**
 * Required keys for a given config. Provider-dependent: asking a Zadarma
 * operator for `TWILIO_ACCOUNT_SID` (or vice versa) would be an unsatisfiable
 * prompt, so the set follows `TELEPHONY_PROVIDER`.
 *
 * An absent or unrecognized provider falls back to COMMON_KEYS alone — the
 * enum error from `validateConfig` is the useful message in that case, and
 * piling seven phantom presence errors on top of it would bury it.
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {string[]}
 */
export function requiredKeys(cfg = {}) {
	const provider = (cfg.TELEPHONY_PROVIDER ?? "").trim();
	// `Object.hasOwn`, NOT `TELEPHONY_KEYS[provider] ?? []`. A plain object literal
	// inherits from Object.prototype, so `provider` equal to "constructor",
	// "toString", "valueOf", "hasOwnProperty" or "__proto__" resolves to an
	// inherited NON-NULL value — `??` never fires, the spread throws
	// `TypeError: extra is not iterable`, and that happens inside `readConfig()`
	// BEFORE `validateConfig` runs, escaping the entrypoint's no-tty-only catch.
	// A typo'd provider would then get a stack trace instead of the carefully
	// worded enum error. Verified 2026-09-07.
	const extra = Object.hasOwn(TELEPHONY_KEYS, provider)
		? (TELEPHONY_KEYS[provider] ?? [])
		: [];
	return [...COMMON_KEYS, ...extra];
}

/**
 * Every key this tool recognizes, across all providers. Used by the entrypoint
 * to decide which file lines to carry over — a Twilio value sitting in a file
 * now used for Zadarma is simply ignored, not an error.
 */
export const CONFIG_KEYS = [
	...COMMON_KEYS,
	...TELEPHONY_PROVIDERS.flatMap((p) => TELEPHONY_KEYS[p] ?? []),
];

/** Optional config keys (validated only when present). */
export const OPTIONAL_KEYS = ["DEEPGRAM_STT_HOST", "DEEPGRAM_MODEL"];

/**
 * A non-empty trimmed string? Typed as a predicate so `checkJs` narrows
 * `cfg.X` from `string | undefined` to `string` inside the `&&` guards below.
 *
 * @type {(v: unknown) => v is string}
 */
const present = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Validate an onboarding config. Pure — returns `{ ok, errors }` where each
 * error is `{ field, message }` (Polish, operator-facing). EU-residency and
 * format rules are HARD: a failure is a rejection, never a warning.
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {{ ok: boolean, errors: { field: string, message: string }[] }}
 */
export function validateConfig(cfg = {}) {
	/** @type {{ field: string, message: string }[]} */
	const errors = [];
	/** @param {string} field @param {string} message */
	const add = (field, message) => errors.push({ field, message });

	// 1. Provider enum FIRST — it decides which keys are required at all, so an
	//    unrecognized value has to report as itself rather than as a pile of
	//    phantom presence errors for a provider nobody asked for.
	if (
		present(cfg.TELEPHONY_PROVIDER) &&
		!TELEPHONY_PROVIDERS.includes(cfg.TELEPHONY_PROVIDER)
	) {
		add(
			"TELEPHONY_PROVIDER",
			`TELEPHONY_PROVIDER musi być jednym z: ${TELEPHONY_PROVIDERS.join(" | ")} — otrzymano "${cfg.TELEPHONY_PROVIDER}". ("mock" jest odrzucany na produkcji przez createTelephony() — jego weryfikacja podpisu przepuszcza każdy webhook.)`,
		);
	}

	// 2. Presence — every key required FOR THIS PROVIDER must carry a value.
	for (const key of requiredKeys(cfg)) {
		if (!present(cfg[key])) add(key, `${key} jest wymagane (brak wartości).`);
	}

	// 3. Format / EU-residency rules. Each guards its value only when present,
	//    so a missing key reports the presence error above (not a noisy double).

	// DATABASE_URL — libsql file path on the Fly volume.
	if (present(cfg.DATABASE_URL) && !cfg.DATABASE_URL.startsWith("file:")) {
		add(
			"DATABASE_URL",
			'DATABASE_URL musi zaczynać się od "file:" (np. file:/data/db.sqlite).',
		);
	}

	// AUTH_SECRET — Auth.js v5 crashes boot if < 32 bytes.
	if (present(cfg.AUTH_SECRET) && cfg.AUTH_SECRET.length < 32) {
		add(
			"AUTH_SECRET",
			'AUTH_SECRET musi mieć min. 32 znaki (wygeneruj: node -e \'console.log(require("crypto").randomBytes(32).toString("hex"))\' — NIE openssl, bywa go brak, a pusty wynik to crash-loop przy boocie).',
		);
	}

	// AUTH_URL — https origin, NO trailing slash, no path (sign-out footgun).
	if (present(cfg.AUTH_URL) && !/^https:\/\/[^/]+$/.test(cfg.AUTH_URL)) {
		add(
			"AUTH_URL",
			"AUTH_URL musi być originem https:// bez ścieżki i bez ukośnika na końcu (np. https://your-app.fly.dev).",
		);
	}

	// AWS_REGION — EU residency: exactly eu-central-1.
	if (present(cfg.AWS_REGION) && cfg.AWS_REGION !== AWS_EU_REGION) {
		add(
			"AWS_REGION",
			`AWS_REGION musi być "${AWS_EU_REGION}" (residency UE) — otrzymano "${cfg.AWS_REGION}".`,
		);
	}

	// BEDROCK_MODEL_ID — EU inference profile only; reject the Global profile.
	if (
		present(cfg.BEDROCK_MODEL_ID) &&
		!cfg.BEDROCK_MODEL_ID.startsWith("eu.")
	) {
		add(
			"BEDROCK_MODEL_ID",
			'BEDROCK_MODEL_ID musi zaczynać się od "eu." (profil UE; NIE używaj profilu Global, który może trafić do US).',
		);
	}

	// DEEPGRAM_STT_HOST (optional) — if set, must be the EU host.
	if (
		present(cfg.DEEPGRAM_STT_HOST) &&
		cfg.DEEPGRAM_STT_HOST !== DEEPGRAM_EU_HOST
	) {
		add(
			"DEEPGRAM_STT_HOST",
			`DEEPGRAM_STT_HOST musi być hostem UE "${DEEPGRAM_EU_HOST}" (residency UE).`,
		);
	}

	// USER_FORWARD_NUMBER / TWILIO_CALLER_ID — E.164.
	if (present(cfg.USER_FORWARD_NUMBER) && !E164.test(cfg.USER_FORWARD_NUMBER)) {
		add(
			"USER_FORWARD_NUMBER",
			"USER_FORWARD_NUMBER musi być w formacie E.164 (np. +48512345678).",
		);
	}
	if (present(cfg.TWILIO_CALLER_ID) && !E164.test(cfg.TWILIO_CALLER_ID)) {
		add(
			"TWILIO_CALLER_ID",
			"TWILIO_CALLER_ID musi być w formacie E.164 (np. +48221234567).",
		);
	}

	// TWILIO_ACCOUNT_SID — Twilio Account SIDs start with "AC".
	if (
		present(cfg.TWILIO_ACCOUNT_SID) &&
		!cfg.TWILIO_ACCOUNT_SID.startsWith("AC")
	) {
		add(
			"TWILIO_ACCOUNT_SID",
			'TWILIO_ACCOUNT_SID musi zaczynać się od "AC" (Account SID, nie API Key SID).',
		);
	}

	// ZADARMA_SIP_EXTENSION — the BARE PBX extension (e.g. "100").
	//
	// This validator exists because the failure it prevents is SILENT: a wrong
	// value returns no error from Zadarma, the outbound callback is placed, the
	// phone rings — and nothing is recorded. It surfaces days later as missing
	// notes, with every probe green.
	//
	// Two wrong forms are rejected, for different reasons:
	//   - `123456-100` — the SIP LOGIN. Unambiguous: an extension never contains
	//     a hyphen. Hard reject.
	//   - `123456` — the PBX ID. This one is a SHAPE HEURISTIC (>= 5 digits),
	//     not a proof: the panel shows both numbers side by side and the API
	//     accepts both, and `.env.spike.local` really did carry the PBX id while
	//     recordings still appeared (handoff.md, 2026-09-05) — so the vendor
	//     tolerates it in at least some paths. We reject anyway because the cost
	//     is asymmetric: a false reject costs the operator 30 seconds and an
	//     edit; a false accept costs unrecorded calls nobody notices. Measured
	//     extensions on the project account are 3 digits (100/101/102).
	if (present(cfg.ZADARMA_SIP_EXTENSION)) {
		const ext = cfg.ZADARMA_SIP_EXTENSION.trim();
		if (!/^\d+$/.test(ext)) {
			add(
				"ZADARMA_SIP_EXTENSION",
				`ZADARMA_SIP_EXTENSION musi być GOŁYM numerem wewnętrznym (np. 100), a nie loginem SIP typu 123456-100 — otrzymano "${ext}". Zły zapis NIE zwraca błędu u dostawcy: rozmowa się zestawia i po prostu nie jest nagrywana.`,
			);
		} else if (ext.length >= 5) {
			add(
				"ZADARMA_SIP_EXTENSION",
				`ZADARMA_SIP_EXTENSION wygląda na id centrali (${ext.length} cyfr), a nie na numer wewnętrzny (zwykle 3 cyfry, np. 100). Panel pokazuje oba obok siebie. Jeśli to naprawdę numer wewnętrzny, zgłoś to — reguła jest heurystyką kształtu.`,
			);
		}
	}

	// PUBLIC_BASE_URL — https origin (used to build the webhook URL).
	if (
		present(cfg.PUBLIC_BASE_URL) &&
		!cfg.PUBLIC_BASE_URL.startsWith("https://")
	) {
		add(
			"PUBLIC_BASE_URL",
			"PUBLIC_BASE_URL musi zaczynać się od https:// (publiczny origin panelu).",
		);
	}

	return { ok: errors.length === 0, errors };
}

/**
 * `record_store` values MEASURED to mean "speech recognition is on, therefore
 * the vendor stores Ogg/Opus 48 kHz STEREO".
 *
 * EXACTLY ONE value has ever been observed: `"For manual recognition"`, read
 * from `GET /v1/pbx/internal/100/info/` on 2026-09-05, on the account whose four
 * recordings passed the stereo gate (`handoff.md:199`). That is the entire
 * evidence base, and this list must not grow beyond it by inference.
 *
 * ⚠️ WHY THIS LIST IS SO SHORT — a correction, not caution. It first shipped as
 * `/recogni|rozpozna|chmur|cloud/i`, with a comment claiming "measured-good forms
 * only" while three of the four tokens were guessed. `chmur`/`cloud` were the
 * dangerous ones: `„W chmurę"` ("to the cloud") is the panel's **storage
 * destination** for recordings (`handoff.md:324`), a DIFFERENT setting from
 * speech recognition — and one that stays ON precisely in the forbidden
 * `speech_recognition=off` state, where recordings become mono 8 kHz mp3. An
 * operator with recording enabled and recognition off would therefore have been
 * told `✅ stereo`, `zadarma.ts` would have kept announcing `audio/ogg` to
 * Deepgram, and speaker separation would have vanished silently — the exact
 * failure this probe exists to break the silence on, signed off as healthy.
 *
 * ⚠️ SECOND-ORDER CAVEAT, stated because it is easy to miss: that
 * `record_store` reflects the speech-recognition setting AT ALL is itself an
 * inference from that single observation. The API response carries no
 * `speech_recognition` field, so this is the best available signal, not a
 * documented one.
 *
 * A value not on this list is REFUSED, including one that looks fine. If you hit
 * a false rejection, add the string you actually READ BACK from the API — never
 * one you translated, localized or reasoned your way to.
 */
const MEASURED_STEREO_RECORD_STORE = [
	// "For manual recognition" — the panel's `optional`. Substring-matched so a
	// wording tweak by the vendor does not fail an operator whose config is right.
	/recognition/i,
];

/**
 * Does this `record_store` value prove the extension records in stereo?
 *
 * Pure and exported so the rule is unit-testable: it lives in a network probe,
 * and the case that matters (`„W chmurę"` must be REFUSED) cannot be exercised
 * without either a live account in the forbidden state or a testable predicate.
 *
 * @param {string | undefined | null} value raw `record_store` from the API
 * @returns {boolean}
 */
export function isStereoCapableRecordStore(value) {
	const store = String(value ?? "").trim();
	if (!store) return false;
	return MEASURED_STEREO_RECORD_STORE.some((re) => re.test(store));
}

/**
 * POSIX-safe single-quote a value for copy-paste into a shell: wrap in single
 * quotes and escape any embedded single quote (`'\''`). The operator pastes the
 * printed command verbatim, so a value containing a space, `$`, backtick, `;`,
 * or quote must never break or mis-execute the command.
 *
 * @param {string} v
 * @returns {string}
 */
function shellSingleQuote(v) {
	return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * Render one `fly secrets set` command from `KEY=value` pairs (skips empties).
 * Values are single-quoted so the emitted string is always paste-safe.
 *
 * @param {[string, string | undefined][]} pairs
 * @returns {string}
 */
function flyCmd(pairs) {
	const assigns = pairs
		.filter(([, v]) => present(v))
		.map(([k, v]) => `${k}=${shellSingleQuote(String(v))}`)
		.join(" ");
	return `fly secrets set ${assigns}`;
}

/**
 * Build the ordered list of `fly secrets set` commands. ORDER IS LOAD-BEARING
 * (mirrors the CLAUDE.md enum-before-secret rule): every `*_PROVIDER` flip is a
 * SEPARATE command that comes AFTER the command setting its credentials, so a
 * provider is never switched on before its secrets exist.
 *
 * Order: (1) boot-critical DATABASE_URL/AUTH_SECRET/AUTH_URL → (2) Deepgram key
 * → (3) STT_PROVIDER flip → (4) AWS/Bedrock creds → (5) LLM_PROVIDER flip →
 * (6) telephony creds + PUBLIC_BASE_URL → (7) TELEPHONY_PROVIDER flip.
 *
 * The telephony pair (6)+(7) follows `cfg.TELEPHONY_PROVIDER`. It used to emit
 * Twilio unconditionally, including the literal `TELEPHONY_PROVIDER=twilio` —
 * see the note on COMMON_KEYS for why that was worse than emitting nothing.
 *
 * `TELEPHONY_PROVIDER` is additionally the one flip with a hard enum-before-
 * secret ordering constraint against the DEPLOYED IMAGE, not just against its
 * own credentials: `zadarma` entered the `src/env.js` enum in
 * `telephony-provider-zadarma` phase 1, so an instance running an older image
 * crash-loops on env validation the moment the secret is set. That ordering is
 * between `fly deploy` and this block, so it cannot be expressed here — the
 * entrypoint prints it as prose instead.
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {string[]}
 */
export function buildSecretCommands(cfg = {}) {
	return [
		// (1) boot-critical
		flyCmd([
			["DATABASE_URL", cfg.DATABASE_URL],
			["AUTH_SECRET", cfg.AUTH_SECRET],
			["AUTH_URL", cfg.AUTH_URL],
		]),
		// (2) STT credentials (host/model only if overridden)
		flyCmd([
			["DEEPGRAM_API_KEY", cfg.DEEPGRAM_API_KEY],
			["DEEPGRAM_STT_HOST", cfg.DEEPGRAM_STT_HOST],
			["DEEPGRAM_MODEL", cfg.DEEPGRAM_MODEL],
		]),
		// (3) STT provider flip — AFTER its creds
		flyCmd([["STT_PROVIDER", "deepgram"]]),
		// (4) LLM credentials
		flyCmd([
			["AWS_ACCESS_KEY_ID", cfg.AWS_ACCESS_KEY_ID],
			["AWS_SECRET_ACCESS_KEY", cfg.AWS_SECRET_ACCESS_KEY],
			["AWS_REGION", cfg.AWS_REGION],
			["BEDROCK_MODEL_ID", cfg.BEDROCK_MODEL_ID],
		]),
		// (5) LLM provider flip — AFTER its creds
		flyCmd([["LLM_PROVIDER", "anthropic-bedrock"]]),
		// (6) telephony credentials + public origin, (7) provider flip — both
		//     chosen by cfg.TELEPHONY_PROVIDER.
		...buildTelephonyCommands(cfg),
	];
}

/**
 * The telephony credential command plus its provider flip, as two commands in
 * that order. Split out so the provider branch is one small readable unit and
 * the ordering assertion in the tests has something stable to point at.
 *
 * `USER_FORWARD_NUMBER` and `PUBLIC_BASE_URL` are common to both branches:
 * every provider rings the user's own GSM, and `calls.placeOutbound` builds an
 * absolute callback URL from the public origin regardless of vendor. (On the
 * Zadarma branch `PUBLIC_BASE_URL` is deliberately NOT a boot guard — see
 * `src/server/telephony/index.ts` — but it is still required for outbound, so
 * it belongs in the block.)
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {string[]}
 */
function buildTelephonyCommands(cfg = {}) {
	const provider = (cfg.TELEPHONY_PROVIDER ?? "").trim();
	// EXHAUSTIVE switch with a throwing default, not `if zadarma else twilio`.
	// The fall-through spelling is how FU-5's defect comes BACK: adding a third
	// vendor the documented way (a value in TELEPHONY_PROVIDERS + an entry in
	// TELEPHONY_KEYS) leaves this function untouched, `validateConfig` passes,
	// `requiredKeys` collects the NEW vendor's credentials — and the tool then
	// prints the TWILIO block plus `TELEPHONY_PROVIDER='twilio'`, under the full
	// "Konfiguracja poprawna ✅" ceremony. Silently emitting the wrong vendor's
	// secrets is the exact failure this whole change was raised to fix, so the
	// omission has to be loud.
	switch (provider) {
		case "zadarma":
			return [
				flyCmd([
					["ZADARMA_USER_KEY", cfg.ZADARMA_USER_KEY],
					["ZADARMA_SECRET", cfg.ZADARMA_SECRET],
					["ZADARMA_SIP_EXTENSION", cfg.ZADARMA_SIP_EXTENSION],
					["USER_FORWARD_NUMBER", cfg.USER_FORWARD_NUMBER],
					["PUBLIC_BASE_URL", cfg.PUBLIC_BASE_URL],
				]),
				flyCmd([["TELEPHONY_PROVIDER", "zadarma"]]),
			];
		case "twilio":
			return [
				flyCmd([
					["TWILIO_ACCOUNT_SID", cfg.TWILIO_ACCOUNT_SID],
					["TWILIO_AUTH_TOKEN", cfg.TWILIO_AUTH_TOKEN],
					["USER_FORWARD_NUMBER", cfg.USER_FORWARD_NUMBER],
					["TWILIO_CALLER_ID", cfg.TWILIO_CALLER_ID],
					["PUBLIC_BASE_URL", cfg.PUBLIC_BASE_URL],
				]),
				flyCmd([["TELEPHONY_PROVIDER", "twilio"]]),
			];
		default:
			throw new Error(
				`buildSecretCommands: brak gałęzi sekretów dla TELEPHONY_PROVIDER="${provider}". Dodając dostawcę, uzupełnij TELEPHONY_PROVIDERS, TELEPHONY_KEYS, buildTelephonyCommands ORAZ buildWebhookInstructions — inaczej narzędzie wypisze blok innego dostawcy.`,
			);
	}
}

/**
 * Strip any trailing slashes from PUBLIC_BASE_URL before joining a path.
 * @param {Record<string, string | undefined>} cfg
 * @returns {string}
 */
function baseOrigin(cfg) {
	return (cfg.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
}

/**
 * Twilio's per-NUMBER Voice webhook URL.
 *
 * The path is `/api/telephony/voice`, not `/api/twilio/voice`: the routes were
 * renamed off the vendor name with NO aliases. A console still pointing at the
 * old path gets a 307 to `/login` from the auth gate — which reads as a working
 * webhook in the Twilio console while capturing nothing.
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {string}
 */
export function buildVoiceWebhookUrl(cfg = {}) {
	return `${baseOrigin(cfg)}/api/telephony/voice`;
}

/**
 * Zadarma's ACCOUNT-level notification URL. Not per number and not per call —
 * one MemoCall instance therefore requires one dedicated Zadarma account.
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {string}
 */
export function buildEventsWebhookUrl(cfg = {}) {
	return `${baseOrigin(cfg)}/api/telephony/events`;
}

/**
 * The vendor-console steps this tool CANNOT perform, as printable lines.
 *
 * Provider-shaped because the two vendors put fundamentally different things in
 * the panel. For Twilio it is one URL field. For Zadarma the panel additionally
 * owns the CALL SCENARIO and the RECORDING SWITCH — i.e. behaviour that used to
 * be ten lines of TwiML under version control. That is the accepted
 * architectural regression of this migration (`change.md` → "Co tracimy" #1),
 * and the only mitigation available to a CLI is to state the steps explicitly
 * so they are not discovered by their silence.
 *
 * @param {Record<string, string | undefined>} cfg
 * @returns {{ url: string, lines: string[] }}
 */
export function buildWebhookInstructions(cfg = {}) {
	const provider = (cfg.TELEPHONY_PROVIDER ?? "").trim();
	// Exhaustive, same reasoning as `buildTelephonyCommands` above: falling
	// through to Twilio would print a third vendor's operator the WRONG console
	// steps — and panel steps are the half of the setup no code can verify later.
	if (provider !== "zadarma" && provider !== "twilio") {
		throw new Error(
			`buildWebhookInstructions: brak kroków panelu dla TELEPHONY_PROVIDER="${provider}". Dodając dostawcę, uzupełnij TELEPHONY_PROVIDERS, TELEPHONY_KEYS, buildTelephonyCommands ORAZ tę funkcję.`,
		);
	}
	if (provider === "zadarma") {
		return {
			url: buildEventsWebhookUrl(cfg),
			lines: [
				`Ustaw URL powiadomień PBX (Ustawienia → Integracje i API) na: ${buildEventsWebhookUrl(cfg)}`,
				"  ⚠ Zapis MUSI się powieść — Zadarma weryfikuje adres handshakiem GET ?zd_echo=<nonce>",
				"    i wymaga odesłania dokładnie tej wartości. Odrzucony zapis = aplikacja jest",
				"    nieosiągalna i nic dalej nie zadziała.",
				"  ⚠ URL jest na poziomie KONTA, nie numeru — jedna instancja MemoCall = jedno konto Zadarmy.",
				"Skonfiguruj trasę przychodzącą (dwa NIEZALEŻNE ogniwa, oba obowiązkowe):",
				"  1) przekierowanie SIP numeru DID → centrala PBX (destination=pbx, warunek: zawsze)",
				"  2) scenariusz przychodzący centrali → numer wewnętrzny (np. 100)",
				"  ⚠ Ogniwo 2 nie jest widoczne w ŻADNYM odczycie API. Półskonfigurowany łańcuch",
				"    odpowiada sygnałem zajętości przy wszystkich sondach na zielono.",
				"Włącz nagrywanie na numerze wewnętrznym — u Zadarmy nagrywanie jest własnością",
				"  NUMERU WEWNĘTRZNEGO, nie połączenia (odwrotnie niż atrybut record w TwiML).",
				"  DID poprowadzony wprost na telefon dzwoni poprawnie i NIE nagrywa nic.",
				"🚫 speech_recognition = off to STAN ZAKAZANY: off → mp3/8 kHz/MONO,",
				"  optional lub all → Ogg/Opus/48 kHz/STEREO. Tylko stereo niesie rozdział mówców",
				"  po kanałach fizycznych. Przełączenie na off cicho zwija każdą przyszłą rozmowę",
				"  do jednego mówcy i NIE zgłasza żadnego błędu. optional jest bezpłatny.",
				"ℹ Ta instancja przechowuje numer i nazwę prezentacji rozmówcy podane przez operatora dla każdej nagranej rozmowy, do czasu jej usunięcia — patrz context/domain/04-privacy-and-anonymity.md §A-1.",
			],
		};
	}
	return {
		url: buildVoiceWebhookUrl(cfg),
		lines: [
			`Ustaw Voice webhook numeru na: ${buildVoiceWebhookUrl(cfg)}`,
			"  ⚠ Ścieżka to /api/telephony/voice, NIE /api/twilio/voice (rename bez aliasów).",
			"    Stary adres dostaje 307 na /login — wygląda jak działający webhook, który nic nie robi.",
			"Włącz ruch wychodzący na +48 (Voice → Geographic Permissions), inaczej error 21210.",
		],
	};
}
