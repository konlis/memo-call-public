// Read-only pre-flight smoke for the onboarding tool (Phase 3). One probe per
// cloud vendor, each a SINGLE read-only call that mutates nothing, returning
// `{ label, ok, reason }`. Catches the silent EU/permission footguns BEFORE
// deploy — the same failures that otherwise only surface as a dead-lettered
// job in `fly logs` (Deepgram US-key 401, Bedrock region/ARN/enablement 403,
// Twilio geo-permissions 21210).
//
// Imported LAZILY by scripts/onboard.mjs only when `--smoke` is passed, so the
// plain advise path never loads the Bedrock SDK and does zero network I/O.
//
// A probe NEVER throws past its own try/catch — a failure (even a network
// blip) becomes a labeled ❌ + reason, so one vendor being down can't abort the
// report for the other two. The Bedrock call mirrors the proven in-repo usage
// in src/server/llm/anthropic-bedrock.ts (same constructor + messages.create).

import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

import { DEEPGRAM_EU_HOST, isStereoCapableRecordStore } from "./lib.mjs";
import { signZadarmaRequest } from "./zadarma-sign.mjs";

const FETCH_TIMEOUT_MS = 10_000;

/** Zadarma's API host. Single-region vendor — no EU/US split to pin. */
const ZADARMA_API_HOST = "api.zadarma.com";

/** Basic-auth header value for Twilio (`Basic base64(sid:token)`). */
function basicAuth(sid, token) {
	return `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
}

/**
 * Deepgram: authenticate against the EU INFERENCE host the way the real
 * provider does — `POST /v1/listen` with `Authorization: Token` (the management
 * `/v1/projects` route does NOT exist on api.eu.deepgram.com → 404, so it can't
 * probe the EU residency footgun). Deepgram checks auth BEFORE the body, so a
 * 1-byte non-audio payload returns 401 for a wrong/US-project key (the footgun)
 * and 400 "can't decode" for a key valid on the EU host — that 400 is success
 * (the byte is intentionally not real audio; nothing is transcribed or stored).
 *
 * @param {Record<string, string>} cfg
 * @returns {Promise<{ label: string, ok: boolean, reason: string }>}
 */
async function probeDeepgram(cfg) {
	const label = "Deepgram (STT, EU)";
	const host = cfg.DEEPGRAM_STT_HOST || DEEPGRAM_EU_HOST;
	try {
		const res = await fetch(`https://${host}/v1/listen`, {
			method: "POST",
			headers: {
				Authorization: `Token ${cfg.DEEPGRAM_API_KEY}`,
				"Content-Type": "audio/wav",
			},
			body: new Uint8Array([0]), // not real audio → 400 if authed, never transcribed
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (res.status === 401 || res.status === 403) {
			return {
				label,
				ok: false,
				reason: `${res.status} — klucz nie należy do projektu EU lub jest błędny`,
			};
		}
		// Authenticated on the EU host: 200 (unlikely for 1 byte) or 400 (can't
		// decode the dummy byte) both prove the key works against the EU endpoint.
		if (res.status === 200 || res.status === 400) {
			return {
				label,
				ok: true,
				reason: `klucz zaakceptowany na hoście EU (${host})`,
			};
		}
		return {
			label,
			ok: false,
			reason: `nieoczekiwany status HTTP ${res.status}`,
		};
	} catch (err) {
		return { label, ok: false, reason: `błąd sieci: ${errMsg(err)}` };
	}
}

/**
 * Twilio: verify the account credentials (GET Account), then verify Poland
 * (+48) outbound is allowed (DialingPermissions) — `low_risk_numbers_enabled`
 * is the field that gates ordinary PL mobile/landline; false → error 21210.
 *
 * @param {Record<string, string>} cfg
 * @returns {Promise<{ label: string, ok: boolean, reason: string }>}
 */
async function probeTwilio(cfg) {
	const label = "Twilio (telefonia + geo +48)";
	const auth = basicAuth(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN);
	try {
		const acc = await fetch(
			`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}.json`,
			{
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			},
		);
		if (acc.status === 401) {
			return {
				label,
				ok: false,
				reason: "401 — błędne TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN",
			};
		}
		if (acc.status !== 200) {
			return {
				label,
				ok: false,
				reason: `konto: nieoczekiwany status ${acc.status}`,
			};
		}

		const geoRes = await fetch(
			"https://voice.twilio.com/v1/DialingPermissions/Countries/PL",
			{
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			},
		);
		if (geoRes.status !== 200) {
			return {
				label,
				ok: false,
				reason: `geo PL: nieoczekiwany status ${geoRes.status}`,
			};
		}
		const geo = await geoRes.json();
		if (geo?.low_risk_numbers_enabled === true) {
			return { label, ok: true, reason: "konto OK, +48 (low-risk) dozwolone" };
		}
		return {
			label,
			ok: false,
			reason: "włącz +48 w Geographic Permissions (inaczej error 21210)",
		};
	} catch (err) {
		return { label, ok: false, reason: `błąd sieci: ${errMsg(err)}` };
	}
}

/**
 * Bedrock: a minimal `messages.create` against the configured EU profile. A
 * region/ARN/enablement mismatch surfaces as 403 AccessDenied / 400 Validation.
 *
 * @param {Record<string, string>} cfg
 * @returns {Promise<{ label: string, ok: boolean, reason: string }>}
 */
async function probeBedrock(cfg) {
	const label = "Bedrock (LLM, EU)";
	try {
		const client = new AnthropicBedrock({
			awsAccessKey: cfg.AWS_ACCESS_KEY_ID,
			awsSecretKey: cfg.AWS_SECRET_ACCESS_KEY,
			awsRegion: cfg.AWS_REGION,
			maxRetries: 1, // smoke = fail fast; don't sit through 5 retries on a 403
			timeout: FETCH_TIMEOUT_MS, // bound like the fetch probes (no multi-min hang)
		});
		await client.messages.create({
			model: cfg.BEDROCK_MODEL_ID,
			max_tokens: 16,
			messages: [{ role: "user", content: "ping" }],
		});
		return { label, ok: true, reason: `model odpowiada (${cfg.AWS_REGION})` };
	} catch (err) {
		const status = err?.status;
		if (status === 401 || status === 403 || status === 400) {
			return {
				label,
				ok: false,
				reason: `${status} — sprawdź region eu-central-1, ARN IAM i enablement Haiku 4.5`,
			};
		}
		return { label, ok: false, reason: `błąd: ${errMsg(err)}` };
	}
}

/**
 * One signed, read-only Zadarma GET. Returns the parsed envelope alongside the
 * HTTP status, because Zadarma answers errors as **HTTP 200 with
 * `{"status":"error"}`** — `res.ok` alone proves nothing here.
 *
 * Signing goes through the shared port in `zadarma-sign.mjs`, which a
 * differential test pins byte-for-byte against the implementation the server
 * authenticates with. That matters more than it looks: Zadarma's two HMAC
 * recipes are asymmetric, and using the wrong one returns a clean 401 that is
 * INDISTINGUISHABLE from a bad key — a drifted probe would confidently blame
 * good credentials.
 *
 * @param {Record<string, string>} cfg
 * @param {string} apiPath  signed VERBATIM, trailing slash included
 * @param {Record<string, string>} params
 */
async function zadarmaGet(cfg, apiPath, params = {}) {
	const { paramsString, authorization } = signZadarmaRequest({
		apiPath,
		params,
		userKey: cfg.ZADARMA_USER_KEY,
		secret: cfg.ZADARMA_SECRET,
	});
	const res = await fetch(
		`https://${ZADARMA_API_HOST}${apiPath}?${paramsString}`,
		{
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		},
	);
	let json = null;
	try {
		json = await res.json();
	} catch {
		// Left null — the caller reports it as an unusable response.
	}
	return { status: res.status, json };
}

/**
 * Zadarma probe #1 — credentials + the extension actually existing.
 *
 * `GET /v1/pbx/internal/` is the call verified live against this account on
 * 2026-09-04 (HTTP 200, `{"status":"success"}`), and it is read-only. It also
 * returns `numbers: [...]`, which lets us catch the `ZADARMA_SIP_EXTENSION`
 * footgun that has no other symptom: a wrong extension does NOT error — the
 * outbound call is placed and simply is not recorded.
 *
 * @param {Record<string, string>} cfg
 * @returns {Promise<{ label: string, ok: boolean, reason: string }>}
 */
async function probeZadarma(cfg) {
	const label = "Zadarma (telefonia, podpis + numer wewn.)";
	try {
		const { status, json } = await zadarmaGet(cfg, "/v1/pbx/internal/");
		if (status === 401 || status === 403) {
			return {
				label,
				ok: false,
				reason: `${status} — błędny ZADARMA_USER_KEY / ZADARMA_SECRET (albo pomylona receptura podpisu)`,
			};
		}
		if (status !== 200) {
			return {
				label,
				ok: false,
				reason: `nieoczekiwany status HTTP ${status}`,
			};
		}
		// HTTP 200 is NOT success at this vendor — check the envelope.
		if (json?.status !== "success") {
			return {
				label,
				ok: false,
				reason: `koperta błędu w HTTP 200: ${json?.message ?? "brak pola message"}`,
			};
		}
		const numbers = (json.numbers ?? []).map(String);
		const ext = String(cfg.ZADARMA_SIP_EXTENSION ?? "").trim();
		if (!numbers.includes(ext)) {
			return {
				label,
				ok: false,
				reason: `podpis OK, ale numer wewnętrzny "${ext}" nie istnieje na koncie (dostępne: ${numbers.join(", ") || "brak"}). Zły numer NIE zwraca błędu u dostawcy — rozmowa po prostu nie jest nagrywana.`,
			};
		}
		return {
			label,
			ok: true,
			reason: `podpis OK, centrala ${json.pbx_id ?? "?"}, numer wewnętrzny ${ext} istnieje`,
		};
	} catch (err) {
		return { label, ok: false, reason: `błąd sieci: ${errMsg(err)}` };
	}
}

/**
 * Zadarma probe #2 — the FORBIDDEN `speech_recognition = off` state.
 *
 * This is the highest-value probe in the file, because the failure it detects
 * is completely silent: with recognition off the vendor stores mp3 / 8 kHz /
 * MONO instead of Ogg/Opus / 48 kHz / STEREO, and only stereo carries the
 * physical-channel speaker split the transcript depends on. Nothing errors —
 * every conversation just quietly collapses to one speaker.
 *
 * FAIL-CLOSED ON AN UNKNOWN VALUE, deliberately. The string the vendor returns
 * for `off` has NEVER been observed, so an allowlist of measured-good values is
 * the only honest polarity: guessing a denylist would let an unseen disabled
 * state pass as healthy, which is precisely the silence we are trying to break.
 *
 * The allowlist itself lives in `lib.mjs` (`isStereoCapableRecordStore`) — pure
 * and unit-tested, because the case that matters is a REJECTION and cannot be
 * exercised here without a live account in the forbidden state. Read the note
 * there before widening it; the first version of this probe was too permissive
 * in exactly the way that mattered.
 *
 * @param {Record<string, string>} cfg
 * @returns {Promise<{ label: string, ok: boolean, reason: string }>}
 */
async function probeZadarmaRecording(cfg) {
	const label = "Zadarma (nagrywanie stereo na numerze wewn.)";
	const ext = String(cfg.ZADARMA_SIP_EXTENSION ?? "").trim();
	try {
		const { status, json } = await zadarmaGet(
			cfg,
			`/v1/pbx/internal/${encodeURIComponent(ext)}/info/`,
		);
		if (status !== 200 || json?.status !== "success") {
			return {
				label,
				ok: false,
				reason: `nie udało się odczytać ustawień numeru ${ext} (HTTP ${status}${json?.message ? `, ${json.message}` : ""}) — sprawdź nagrywanie ręcznie w panelu`,
			};
		}
		const store = String(json.record_store ?? "").trim();
		if (!store) {
			return {
				label,
				ok: false,
				reason: `API nie zwróciło record_store dla numeru ${ext} — sprawdź ręcznie, że nagrywanie jest włączone i speech_recognition ≠ off`,
			};
		}
		if (!isStereoCapableRecordStore(store)) {
			return {
				label,
				ok: false,
				reason: `record_store = "${store}" — NIE jest to żadna ze ZMIERZONYCH wartości oznaczających stereo. Uwaga: wartość opisująca samo MIEJSCE składowania (np. "W chmurę") NIE dowodzi stereo — nagrywanie zostaje włączone także przy speech_recognition=off, a wtedy nagrania są mp3/8 kHz/MONO i rozdział mówców znika bez żadnego błędu. Ustaw rozpoznawanie mowy na "optional" (bezpłatne) lub "all". Jeśli ta wartość jest poprawna, dopisz ją do MEASURED_STEREO_RECORD_STORE w lib.mjs — ale tylko po ODCZYTANIU jej z API przy potwierdzonym stereo, nigdy z tłumaczenia.`,
			};
		}
		return {
			label,
			ok: true,
			reason: `record_store = "${store}" → stereo (rozdział mówców po kanałach fizycznych)`,
		};
	} catch (err) {
		return { label, ok: false, reason: `błąd sieci: ${errMsg(err)}` };
	}
}

/** Short, safe error description for a probe reason. */
function errMsg(err) {
	if (err && typeof err === "object" && "message" in err) {
		return String(err.message);
	}
	return String(err);
}

/**
 * Run the read-only probes concurrently: STT + LLM always, plus the telephony
 * probes for the SELECTED provider.
 *
 * The telephony set is provider-scoped rather than "run everything": probing
 * Twilio for a Zadarma instance would report ❌ on credentials that correctly do
 * not exist, training the operator to ignore a red line — which is how a real
 * ❌ later gets waved through.
 *
 * @param {Record<string, string>} cfg
 * @returns {Promise<{ results: { label: string, ok: boolean, reason: string }[], allOk: boolean }>}
 */
export async function runSmoke(cfg) {
	const provider = (cfg.TELEPHONY_PROVIDER ?? "").trim();
	const telephonyProbes =
		provider === "zadarma"
			? [probeZadarma(cfg), probeZadarmaRecording(cfg)]
			: [probeTwilio(cfg)];
	const results = await Promise.all([
		probeDeepgram(cfg),
		...telephonyProbes,
		probeBedrock(cfg),
	]);
	return { results, allOk: results.every((r) => r.ok) };
}
