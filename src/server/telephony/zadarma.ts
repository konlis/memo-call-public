import { randomUUID } from "node:crypto";

import { ProviderError } from "~/server/_lib/provider-error";
import { redactPhoneNumbers } from "~/server/_lib/redact";
import type {
	CounterpartyResolution,
	PendingRecording,
	RecordingEvent,
	TelephonyProvider,
	WebhookSignatureInput,
} from "~/server/telephony/types";
import { mapZadarmaCounterparties } from "~/server/telephony/zadarma-counterparty";
import {
	isZadarmaRecordingEvent,
	PBX_CALL_ID_SHAPE,
	parseZadarmaRecordingEvent,
} from "~/server/telephony/zadarma-params";
import {
	signZadarmaRequest,
	verifyZadarmaWebhookSignature,
} from "~/server/telephony/zadarma-signature";
import {
	countZadarmaStatisticsRows,
	scanZadarmaStatistics,
} from "~/server/telephony/zadarma-statistics";

/** Production API host. Zadarma has no region variants — one host, EU-only company. */
const API_HOST = "api.zadarma.com";

/**
 * Signed paths, WITH the trailing slash. The signature covers the path string
 * verbatim, so these constants are simultaneously "what we sign" and "what we
 * request" — they must never drift apart. Measured 2026-09-05 across eight
 * probes: the trailing-slash form authenticates, and the spike's no-slash
 * fallback never fired, so production pins one form instead of looping over
 * variants (a loop would double every request).
 */
const RECORD_REQUEST_PATH = "/v1/pbx/record/request/";
const CALLBACK_PATH = "/v1/request/callback/";
const STATISTICS_PATH = "/v1/statistics/pbx/";

/**
 * Page size asked for explicitly, and the number the truncation guard compares
 * against. Zadarma's documented default and maximum are both 1000; asking for it
 * by name is what makes a full page DETECTABLE rather than a silent page 1.
 */
const STATISTICS_PAGE_LIMIT = 1000;

/**
 * Ceiling on the statistics request when the caller supplies no signal of its
 * own. The reconcile sweep runs INSIDE the job poller's tick, and `startPoller`
 * is a bare `setInterval` with no in-flight guard — so an unbounded request
 * (undici's default header timeout is ~300 s, longer than the reconcile cadence)
 * would let stalled calls pile up rather than be cancelled.
 */
const STATISTICS_TIMEOUT_MS = 30_000;

/** Seconds the issued download link stays valid. Generous: the pull is streamed. */
const RECORDING_LINK_LIFETIME = "1800";

/**
 * The clock Zadarma's statistics endpoints speak.
 *
 * MEASURED 2026-09-08: `/v1/statistics/*` interprets `start` / `end` in ACCOUNT
 * time, not UTC, and this account reads UTC+2. A window computed in UTC loses
 * the most recent two hours of calls — exactly the ones reconciliation is for.
 *
 * ⚠️ IT IS A ZONE, NOT AN OFFSET, and that distinction is load-bearing. The
 * measurement was taken in September, when Poland is on CEST (UTC+2); the same
 * account reads UTC+1 from late October. A hardcoded `+120` would therefore be
 * correct today and wrong all winter — and the damage is not symmetric. The
 * reconcile window ends at `now − grace`, and the grace is MANDATORY (a
 * recording the vendor reports before the file is fetchable would dead-letter a
 * conversation the webhook path would have handled). Sending a winter timestamp
 * one hour LATE pushes `end` fifty minutes into the future and silently deletes
 * the grace. The opposite error (a zone that runs early) merely delays a
 * backfill by an hour and self-corrects on the next sweep. So when in doubt,
 * prefer the clock that tracks DST.
 *
 * `Europe/Warsaw` is the operator's own zone and agrees with the September
 * measurement. Node ships full ICU, so this needs no extra dependency.
 */
const ACCOUNT_TIME_ZONE = "Europe/Warsaw";

/**
 * Render a UTC instant as `YYYY-MM-DD HH:MM:SS` in the account's clock — the
 * only place in this provider where that shift is applied. Results coming BACK
 * from the vendor are deliberately never shifted (see `zadarma-statistics.ts`):
 * one direction, one place, so there is nothing to get out of step.
 *
 * Built from `Intl` parts rather than string-slicing a locale format, because
 * the latter silently varies with the host locale.
 */
function formatAccountTime(instant: Date): string {
	// `formatToParts` throws a bare RangeError on an invalid Date, which would
	// escape a method contracted to throw only ProviderError. Cheap to close.
	if (Number.isNaN(instant.getTime())) {
		throw new ProviderError({
			code: "invalid_response",
			message: "statistics window carried an invalid date",
		});
	}
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: ACCOUNT_TIME_ZONE,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(instant);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	// `hour: "2-digit"` with hour12:false yields "24" for midnight on some ICU
	// versions; normalize it to the "00" the vendor's format expects.
	const hour = get("hour") === "24" ? "00" : get("hour");
	return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

function statusToCode(status: number): "auth" | "transport" {
	return status === 401 || status === 403 ? "auth" : "transport";
}

/**
 * Summarize an identifier's SHAPE without carrying the identifier itself into
 * the logs — enough to diagnose a format change (`in_<hex:40>` vs `in_<hex:64>`)
 * while keeping a call identifier out of a log line nobody scoped for it.
 */
function describeIdShape(value: string): string {
	// Capped BEFORE any work: the value is vendor- (or caller-) supplied and this
	// ends up on one line of a 7-day log window.
	return value
		.slice(0, 64)
		.replace(/[0-9a-f]{8,}/g, (run) => `<hex:${run.length}>`)
		.replace(/[0-9A-F]{8,}/g, (run) => `<HEX:${run.length}>`)
		.replace(/\d{3,}/g, (run) => `<digits:${run.length}>`);
}

/**
 * The one place an HTTP status or an error envelope becomes a `ProviderError`
 * code. Zadarma reports most failures as HTTP 200 with `{"status":"error"}`, so
 * a caller checking `res.ok` alone would read a failure as a success — this
 * guard is why no method is allowed to inspect `res.ok` on its own.
 *
 * Returns the parsed envelope so callers can read their expected field off it.
 */
function assertZadarmaOk(
	res: Response,
	json: unknown,
	label: string,
): Record<string, unknown> {
	if (!res.ok) {
		throw new ProviderError({
			code: statusToCode(res.status),
			message: `${label} returned HTTP ${res.status}`,
		});
	}
	if (typeof json !== "object" || json === null) {
		throw new ProviderError({
			code: "invalid_response",
			message: `${label} returned a non-JSON body`,
		});
	}
	const envelope = json as Record<string, unknown>;
	// POSITIVE assertion, not "reject the known-bad" (impl-review F4). Refusing
	// only an explicit `status:"error"` let every other 200 JSON object through as
	// a success — an envelope shape change, a partial body, an intermediary's
	// page. That is the same allow-by-default shape this whole file exists to
	// reject one layer up ("`res.ok` is never sufficient"). Measured: all three
	// endpoints this provider calls return an explicit `status` field.
	if (envelope.status !== "success") {
		throw new ProviderError({
			code: "invalid_response",
			// REDACTED (impl-review F5). This message is persisted verbatim into
			// `processing_jobs.last_error` (worker.ts) and printed by
			// `calls.ts`'s audit line, and a vendor error plausibly quotes the
			// number being dialled. A job row and a log line are not among the
			// places this system may hold a phone number (`schema.ts`, FR-025:
			// `dialed_numbers`, `contacts`, `conversations.counterparty_e164`).
			// `twilio.ts` never echoes a
			// vendor body at all; this keeps the diagnostic, minus the digits.
			message: `${label} failed: ${redactVendorMessage(
				String(
					envelope.message ?? `status=${String(envelope.status ?? "absent")}`,
				),
			)}`,
		});
	}
	return envelope;
}

/**
 * De-identify and cap a vendor-supplied message before it reaches a log line.
 *
 * Zadarma's error text is free-form and attacker-influenceable in the general
 * case; more importantly an outbound failure plausibly quotes the number being
 * dialled, and a statistics error may quote a `clid`. A log line is not one of
 * the places this system may hold a phone number (schema.ts).
 *
 * Delegates to the shared sanitizer (`caller-identity-in-archive` phase 2) and
 * masks BEFORE the 120-char cut. The previous local mask ran after the cut and
 * matched only an unbroken digit run, so a number with separators
 * (`+48 500 100 200`) or one straddling the cut passed through.
 */
function redactVendorMessage(message: string): string {
	return redactPhoneNumbers(message).slice(0, 120);
}

/**
 * Return the vendor's message if — and only if — this response means "that
 * RECORDING is already gone", else `null`.
 *
 * TWO GUARDS, both learned the hard way (impl-review F1):
 *
 *   1. `res.ok` FIRST. Without it an HTTP 401 whose body reads
 *      `{"status":"error","message":"user not found"}` — a rotated or typo'd
 *      ZADARMA_USER_KEY — resolves as a successful delete. The caller then
 *      stamps `recording_deleted_at` (worker.ts:443, scheduler.ts:160), the row
 *      leaves the sweep set FOREVER, and the recording lives on at the vendor
 *      while we assert it does not. That is the orphaned-recording failure this
 *      migration is already paying for on the abandoned Twilio account.
 *   2. The match is anchored to the RECORD, not to the words "not found".
 *      Measured against the previous, looser pattern: `user not found`,
 *      `Login not found` and — worst — `API method not found` all matched. The
 *      last one is not hypothetical: the DELETE verb/path on
 *      `/v1/pbx/record/request/` has NEVER been exercised against the live API,
 *      so "method not found" is exactly what a wrong guess returns, and it would
 *      have marked every recording deleted without ever deleting one.
 *
 * Deliberately NARROW in one direction only. A false failure costs the sweeper a
 * retry; a false success costs the guarantee. `no records for this account` is
 * NOT matched on purpose — it reads as an account-level condition, not as
 * "this recording is gone".
 *
 * The exact wording is still UNCONFIRMED (no double-delete was exercised in the
 * spike). Phase 4 pins it; every hit meanwhile emits an audit line so a
 * systematic false success is visible in `fly logs` instead of silent.
 */
function alreadyGoneMessage(res: Response, json: unknown): string | null {
	if (!res.ok) return null;
	if (typeof json !== "object" || json === null) return null;
	const envelope = json as Record<string, unknown>;
	if (envelope.status !== "error") return null;
	const message = String(envelope.message ?? "");
	const gone =
		/\b(?:record|recording|call)\b[^.]{0,40}\bnot\s*found\b/i.test(message) ||
		/\bno\s+such\s+(?:record|recording)\b/i.test(message);
	return gone ? message : null;
}

export type ZadarmaConfig = {
	userKey?: string;
	secret?: string;
	forwardNumber?: string;
	/**
	 * PBX extension the outbound callback dials FROM, and the single switch that
	 * decides whether an outbound call is recorded at all. NOT in the
	 * constructor's required-field guard — outbound-only, exactly like Twilio's
	 * `callerId` (F1): coupling it to construction would crash the live INBOUND
	 * path at boot over a secret only outbound needs. Validated lazily inside
	 * `placeCall`.
	 *
	 * A BARE extension number (`100`) — not the SIP login (`123456-100`) and not
	 * the PBX id (`123456`). A wrong value does not return an error: the call is
	 * placed and simply is not recorded.
	 */
	sipExtension?: string;
	/** API host override. Exists for tests; production never sets it. */
	apiHost?: string;
};

/**
 * Upper bound on the `zd_echo` value this provider will reflect. Their challenge
 * is a short random token (measured: well under 100 chars); the cap exists so the
 * unauthenticated handshake cannot be used as a general-purpose text reflector.
 */
const MAX_CHALLENGE_ECHO_LENGTH = 256;

/**
 * Real Zadarma capture provider — mirror file of `twilio.ts`, same shape and the
 * same comment density. Raw `fetch`, deliberately NO vendor SDK: the official
 * `zadarma-api` package would have to be installed into the ROOT
 * `package.json`, which ships to the production image (CLAUDE.md), and its
 * webhook verifier carries the fail-open gap `zadarma-signature.ts` exists to
 * close.
 *
 * FOUR THINGS DIFFER FROM THE TWILIO MIRROR, all of them measured, not assumed:
 *
 *   1. Failure is reported as HTTP 200 with `{"status":"error"}`, so `res.ok` is
 *      never sufficient — every API call goes through `assertZadarmaOk`.
 *   2. The recording pull is TWO steps: a signed request for a download link,
 *      then an UNAUTHENTICATED GET on that link. Both must honor `signal`.
 *   3. There is no inbound voice webhook — `buildInboundResponse` is absent on
 *      purpose (see the comment where Twilio implements it).
 *   4. The notification URL is per ACCOUNT, configured in Zadarma's panel, so
 *      `recordingStatusCallbackUrl` is a SILENT NO-OP here (loss #4 in
 *      `change.md`). It stays in the signature because the interface is shared.
 */
export class ZadarmaTelephonyProvider implements TelephonyProvider {
	private readonly userKey: string;
	private readonly secret: string;
	private readonly forwardNumber: string;
	/** Outbound-only; may be undefined at construction (see ZadarmaConfig). */
	private readonly sipExtension?: string;
	private readonly host: string;

	/** Zadarma signs webhooks with `Signature`; lowercase per the interface contract. */
	readonly signatureHeader = "signature";

	/**
	 * Ogg/Opus 48 kHz stereo — measured on four live recordings (gate 1, PASS).
	 *
	 * ⚠️ TRUE ONLY WHILE `speech_recognition != off` ON THE PBX EXTENSION. `off`
	 * silently swaps the recording engine to mono 8 kHz mp3, which does three
	 * things at once and reports none of them: it kills the physical-channel
	 * speaker split MemoCall's transcripts are built on, and it makes THIS
	 * declaration false — the job layer forwards it to Deepgram as the upload's
	 * content type, so mp3 bytes would be announced as Ogg. `off` is a FORBIDDEN
	 * STATE, not a preference.
	 *
	 * Note the download itself is served as `application/octet-stream`, so this
	 * value is declared, never read off the response (FU-1's ext/MIME drift
	 * cannot happen here: the link is opaque, we choose no extension).
	 */
	readonly recordingContentType = "audio/ogg";

	constructor(config: ZadarmaConfig) {
		const missing = (["userKey", "secret", "forwardNumber"] as const)
			.filter((k) => !config[k])
			.join(", ");
		if (missing) {
			// Loud failure at construction, mirroring twilio.ts and the STT/LLM real
			// branches — never a silent fallback to mock. For `secret` this is the
			// PRIMARY defense behind impl-review F3: `ZADARMA_SECRET` is `.optional()`
			// in `src/env.js`, and `createHmac("sha1", "")` does not throw, so an
			// empty secret would otherwise verify every webhook against a MAC anyone
			// can compute. `verifyZadarmaWebhookSignature` refuses an empty secret
			// too; that is the second layer, not a reason to drop this one.
			throw new ProviderError({
				code: "auth",
				message: `zadarma telephony provider misconfigured — missing: ${missing}`,
			});
		}
		this.userKey = config.userKey as string;
		this.secret = config.secret as string;
		this.forwardNumber = config.forwardNumber as string;
		// sipExtension intentionally NOT in the guard — outbound-only (see ZadarmaConfig).
		this.sipExtension = config.sipExtension;
		this.host = config.apiHost ?? API_HOST;
	}

	/**
	 * Signed API call. GET carries the signed `paramsString` as the query string;
	 * every other method carries it as a form-encoded body — the SAME string that
	 * was signed, never a freshly built one (`format=json` is part of the signed
	 * text).
	 *
	 * Returns the raw response alongside the parsed body so a caller can inspect
	 * the status BEFORE `assertZadarmaOk` collapses it (`deleteRecording` needs
	 * that for its idempotent 404).
	 */
	private async callApi(input: {
		apiPath: string;
		params: Record<string, string>;
		method: "GET" | "DELETE";
		label: string;
		signal?: AbortSignal;
	}): Promise<{ res: Response; json: unknown }> {
		const { paramsString, authorization } = signZadarmaRequest({
			apiPath: input.apiPath,
			params: input.params,
			userKey: this.userKey,
			secret: this.secret,
		});
		const headers: Record<string, string> = { Authorization: authorization };
		const init: RequestInit = { method: input.method, headers };
		let url = `https://${this.host}${input.apiPath}`;
		if (input.method === "GET") {
			url = `${url}?${paramsString}`;
		} else {
			init.body = paramsString;
			headers["Content-Type"] = "application/x-www-form-urlencoded";
		}
		if (input.signal) init.signal = input.signal;

		let res: Response;
		try {
			res = await fetch(url, init);
		} catch (cause) {
			// On a teardown abort `fetch` rejects with the signal's `reason`, which
			// the worker's bridge sets to a ProviderError — pass it through so the
			// job layer keeps switching on the real discriminator.
			if (cause instanceof ProviderError) throw cause;
			throw new ProviderError({
				code: "transport",
				message: `${input.label} failed`,
				cause,
			});
		}
		let json: unknown = null;
		try {
			json = await res.json();
		} catch {
			// Left as null — assertZadarmaOk turns it into invalid_response (or into
			// the status-derived code, which is the more informative one).
		}
		return { res, json };
	}

	verifySignature(input: WebhookSignatureInput): boolean {
		// `url` is deliberately ignored: Zadarma's MAC covers only the concatenated
		// body fields — no URL, no timestamp, no nonce. That is why the partial
		// unique index `conv_user_callsid_uq` is a security control for this
		// provider (see zadarma-signature.ts).
		//
		// THE MAC IS CHECKED FIRST, and the ordering is load-bearing (impl-review F3):
		// this endpoint is unauthenticated by construction — the signature IS the
		// authorization — so anything done before the MAC is work an anonymous caller
		// can trigger for free. The id-shape refusal below writes a log line, and on a
		// Machine whose only audit trail is Fly's ~7-day window, an unauthenticated
		// log-write primitive is a way to evict evidence. Checking the MAC first costs
		// nothing in security: the forgery the shape check exists to stop (a shifted
		// field boundary) carries a VALID MAC by construction, so it still reaches the
		// shape gate.
		if (
			!verifyZadarmaWebhookSignature({
				signature: input.signature,
				params: input.params ?? {},
				secret: this.secret,
			})
		) {
			// Fail-closed for everything the primitive cannot verify, including the
			// seven ordinary lifecycle events whose signed field sets we deliberately
			// do not know.
			//
			// ⚠️ POLICY DECISION (impl-review F1), recorded here because this is the
			// file the review pointed at: those seven events must end as a 200 no-op,
			// NOT a 403 — Zadarma posts them to the same account-level URL on every
			// call, and a 403 storm is indistinguishable from the broken-HMAC symptom
			// the plan's live-run criterion watches for. The fix was NOT to return
			// `true` here (that re-creates the vendor-SDK fail-open this provider
			// exists to avoid); it was for the HANDLER to decide authorization after
			// it knows the event is not actionable. That reordering LANDED in phase 3
			// — see the AUTHORIZATION ORDER note in `webhooks.ts` — so this refusal is
			// now reached only for an event the handler does act on. Keep it fail-
			// closed: the handler's relaxation covers non-actionable events only, and
			// it relies on this primitive staying strict for `NOTIFY_RECORD`.
			return false;
		}

		// Past this line the caller HOLDS THE SECRET. A shape mismatch here is
		// therefore not an attack in the ordinary case — it is the vendor's id format
		// having drifted, which is precisely what this log line exists to name.
		const params = input.params ?? {};
		if (isZadarmaRecordingEvent(params)) {
			const pbxCallId = params.pbx_call_id ?? "";
			const recordingId = params.call_id_with_rec ?? "";
			if (!PBX_CALL_ID_SHAPE.test(pbxCallId) || recordingId.length === 0) {
				console.error(
					JSON.stringify({
						event: "telephony.zadarma.malformed_id",
						// Date.now() to match logJobEvent / logAuthEvent — one stderr
						// stream must not carry two timestamp types.
						ts: Date.now(),
						pbxCallIdShape: describeIdShape(pbxCallId),
						recordingIdShape: describeIdShape(recordingId),
					}),
				);
				return false;
			}
		}
		return true;
	}

	/**
	 * `buildInboundResponse` is DELIBERATELY NOT IMPLEMENTED — its absence is the
	 * contract's way of saying this provider has no inbound voice webhook. The
	 * call scenario (DID → PBX 123456 → extension 100 → GSM) lives in Zadarma's
	 * panel, not in our code, so there is nothing for us to generate per request.
	 * The handler answers 404, which is the honest answer: for this provider that
	 * endpoint genuinely does not exist.
	 *
	 * This is also the architectural regression the migration accepts knowingly
	 * (loss #1 in `change.md`): the scenario leaves version control, so no diff,
	 * no test and no rollback can catch someone flipping it in the panel.
	 */

	handleChallenge(url: URL): { body: string; contentType: string } | null {
		const echo = url.searchParams.get("zd_echo");
		if (echo === null) return null;
		// Length cap (impl-review phase 3, F5). Zadarma's challenge is a short
		// random token; anything longer is not its handshake. Without this the
		// endpoint is an unauthenticated open text-reflector on our own origin —
		// small, but free to abuse and pointless to leave open. Refusing (→ 404)
		// rather than truncating: a truncated echo would fail their exact-equality
		// check anyway, and a 404 says the honest thing.
		if (echo.length > MAX_CHALLENGE_ECHO_LENGTH) return null;
		// Echoed byte-for-byte: no trim, no newline, no BOM. Zadarma compares for
		// exact equality and, on a mismatch, simply refuses to save the URL in its
		// panel — nothing reaches our logs, so a mangled echo is invisible from
		// this side. `text/plain` and ONLY `text/plain`: this reflects
		// caller-controlled content on an endpoint that is unauthenticated by
		// construction (the handshake is how the provider verifies US).
		return { body: echo, contentType: "text/plain" };
	}

	parseRecordingEvent(params: Record<string, string>): RecordingEvent {
		return parseZadarmaRecordingEvent(params);
	}

	async placeCall(input: {
		to: string;
		recordingStatusCallbackUrl: string;
	}): Promise<{ callSid: string }> {
		// Lazy validation (F1): the extension is outbound-only, so its absence must
		// not block construction — but outbound without it would place a call that
		// is silently NOT recorded, which is worse than failing. Fail loud + audited
		// before any REST call.
		if (!this.sipExtension) {
			throw new ProviderError({
				code: "auth",
				message: "zadarma outbound requires ZADARMA_SIP_EXTENSION",
			});
		}
		// `from` is the operator's own GSM — it rings FIRST, then Zadarma bridges to
		// `to`, the same two-leg shape as the Twilio click-to-call. `sip` is what
		// makes the call run through the recording extension.
		//
		// `input.recordingStatusCallbackUrl` is UNUSED and that is not an oversight:
		// Zadarma's notification URL is an ACCOUNT-level setting configured in their
		// panel (loss #4 in change.md). One MemoCall instance = one Zadarma account.
		const { res, json } = await this.callApi({
			apiPath: CALLBACK_PATH,
			params: {
				from: this.forwardNumber,
				to: input.to,
				sip: this.sipExtension,
			},
			method: "GET",
			label: "outbound callback request",
		});
		const envelope = assertZadarmaOk(res, json, "outbound callback request");

		// MEASURED on the first live outbound call (2026-09-05, local panel against
		// the real API): the success envelope carried NONE of `call_id`,
		// `pbx_call_id` or `id`, so the synthesized branch is the normal path, not
		// the fallback. The lookup stays because one sample is not a spec and it
		// costs nothing.
		//
		// The synthesized value feeds ONLY the audit line in `calls.ts:78`; nothing
		// persists it, and it does NOT correlate with the `pbx_call_id` that arrives
		// later by webhook — that is the id the conversation row is actually keyed
		// on. Anyone tempted to join the two has misread this comment.
		const vendorId = envelope.call_id ?? envelope.pbx_call_id ?? envelope.id;
		if (typeof vendorId === "string" && vendorId.length > 0) {
			return { callSid: vendorId };
		}
		return { callSid: `zadarma-callback-${randomUUID()}` };
	}

	/** Step 1 of the two-step pull: exchange the recording id for a download link. */
	private async requestRecordingLink(
		recordingSid: string,
		signal?: AbortSignal,
	): Promise<string> {
		const label = "recording link request";
		const { res, json } = await this.callApi({
			apiPath: RECORD_REQUEST_PATH,
			params: { call_id: recordingSid, lifetime: RECORDING_LINK_LIFETIME },
			method: "GET",
			label,
			// Without this, a teardown abort would leave THIS request hanging while
			// the caller has already given up.
			signal,
		});
		const envelope = assertZadarmaOk(res, json, label);
		const link =
			typeof envelope.link === "string"
				? envelope.link
				: Array.isArray(envelope.links) && typeof envelope.links[0] === "string"
					? envelope.links[0]
					: undefined;
		if (!link) {
			throw new ProviderError({
				code: "invalid_response",
				message: "recording link request returned no link",
			});
		}
		return link;
	}

	async streamRecording(
		input: { recordingSid: string },
		sink: WritableStream<Uint8Array>,
		opts?: { signal?: AbortSignal },
	): Promise<void> {
		const link = await this.requestRecordingLink(
			input.recordingSid,
			opts?.signal,
		);

		// Step 2 is UNAUTHENTICATED — the link carries its own capability. Measured
		// on a live recording: no redirect, `Content-Type: application/octet-stream`,
		// `Content-Length` present, no chunked encoding.
		let res: Response;
		try {
			const init: RequestInit = {};
			if (opts?.signal) init.signal = opts.signal;
			res = await fetch(link, init);
		} catch (cause) {
			if (cause instanceof ProviderError) throw cause;
			throw new ProviderError({
				code: "transport",
				message: "recording media fetch failed",
				cause,
			});
		}
		if (!res.ok) {
			throw new ProviderError({
				code: statusToCode(res.status),
				message: `recording media fetch returned ${res.status}`,
			});
		}
		if (!res.body) {
			throw new ProviderError({
				code: "invalid_response",
				message: "recording media response had no body",
			});
		}
		// Straight through — the recording never lands on the 256 MB Machine's heap.
		// pipeTo rejects with the raw stream error on a mid-download drop, or with
		// the signal's `reason` (a ProviderError) on a teardown abort; remap the
		// former, pass the latter through. Copied from twilio.ts deliberately: the
		// job worker switches on the discriminator, so both providers must produce
		// the same one.
		try {
			await res.body.pipeTo(sink, { signal: opts?.signal });
		} catch (cause) {
			if (cause instanceof ProviderError) throw cause;
			throw new ProviderError({
				code: "transport",
				message: "recording media stream interrupted",
				cause,
			});
		}
	}

	async deleteRecording(input: { recordingSid: string }): Promise<void> {
		const label = "recording delete";
		const { res, json } = await this.callApi({
			apiPath: RECORD_REQUEST_PATH,
			params: { call_id: input.recordingSid },
			method: "DELETE",
			label,
		});
		// Idempotent (FR-002) — but ONLY through the envelope below, never through a
		// bare HTTP 404.
		//
		// This used to open with `if (res.status === 404) return;`, copied verbatim
		// from `twilio.ts`. It was correct THERE and is still refused HERE — but
		// for a WEAKER reason than this comment used to give, and the correction
		// matters because the old reasoning would justify things it should not.
		//
		// ❌ THE OLD RATIONALE, DISPROVEN: "Zadarma requests the FIXED path
		// `RECORD_REQUEST_PATH` and carries `call_id` in the signed params, so a
		// 404 here CANNOT describe the recording at all — it can only mean the
		// path or the verb does not exist." That inference was tidy and wrong. The
		// read-only probes run during the capture-reconciliation frame (2026-09-08,
		// recorded in that change's `frame.md`) showed this same fixed path
		// answering 404 ABOUT THE RECORDING on a `GET`. Addressing a resource
		// through signed params rather than the URL path evidently does not stop
		// this vendor from using the status code to talk about it.
		//
		// ✅ WHY THE BEHAVIOUR IS UNCHANGED ANYWAY. The measurement was on `GET`,
		// not on `DELETE`, and this DELETE verb/path has still never been exercised
		// against the live API (see the note on `RECORD_REQUEST_PATH` above). So a
		// 404 on THIS call remains ambiguous between "that recording is gone" and
		// "that verb does not exist here" — and the two readings have wildly
		// asymmetric costs, which is what actually decides it, not the inference
		// above.
		//
		// Reading it as success turned every delete into a silent false success:
		// `worker.ts` stamps `recordingDeletedAt`, `scheduler.ts` filters on
		// `isNull(recordingDeletedAt)` so the row leaves the sweep set permanently,
		// the audio stays at the vendor, and the system asserts it is gone — the
		// exact orphaned-recording failure this project already pays for on the
		// abandoned Twilio account. Unlike the envelope branch below it emitted NO
		// audit line, so it was invisible in `fly logs`.
		//
		// A 404 now falls through to `assertZadarmaOk` → `transport`, which the
		// delete sweeper retries. If a live double-delete ever proves Zadarma really
		// answers 404 for an absent RECORDING, re-add it BELOW this line and under
		// the same `delete_assumed_gone` audit line, never above it.
		const gone = alreadyGoneMessage(res, json);
		if (gone !== null) {
			// Audited, because this branch ASSERTS a deletion it did not perform.
			// If the vendor's real wording ever drifts into it wrongly, the only
			// other symptom is recordings quietly accumulating against the 200 MB
			// free quota until new ones stop being stored.
			console.error(
				JSON.stringify({
					event: "telephony.zadarma.delete_assumed_gone",
					ts: Date.now(),
					message: redactVendorMessage(gone),
				}),
			);
			return;
		}
		assertZadarmaOk(res, json, label);
	}

	/**
	 * Which recordings are still lying at Zadarma in `[since, until]` — i.e. the
	 * capture debt (see `PendingRecording`). One signed GET, no paging: at one
	 * user a 24 h window is tens of rows.
	 *
	 * THREE THINGS ARE NOT OPTIONAL HERE, each of which fails silently:
	 *
	 *   1. `version: "2"`. Without it the response omits `pbx_call_id`
	 *      ENTIRELY and still looks well-formed — every row would then be dropped
	 *      by the mapper's id check and the debt ledger would read permanently
	 *      empty. There is no error to notice.
	 *   2. `assertZadarmaOk`. This vendor reports failure as HTTP 200 with
	 *      `{"status":"error"}`, so `res.ok` is never sufficient — an auth failure
	 *      would otherwise arrive as "nothing is pending".
	 *   3. The account-clock shift on `start` / `end` (see `ACCOUNT_TIME_ZONE`).
	 *
	 * A `null` from the mapper means the envelope did not have the shape it
	 * knows, which is NOT the same as an empty window and must not degrade into
	 * one — it throws, and the sweep logs a named failure. Silence about a
	 * reconciliation failure would recreate, one layer up, exactly the blind spot
	 * reconciliation exists to remove.
	 *
	 * The response carries the other party's phone number on every row. Nothing
	 * here reads it, and `PendingRecording` has no field it could occupy — see
	 * the header of `zadarma-statistics.ts` for why that is structural.
	 */
	async listRecordingsAwaitingCapture(input: {
		since: Date;
		until: Date;
		signal?: AbortSignal;
	}): Promise<PendingRecording[]> {
		const label = "pbx statistics request";
		const { res, json } = await this.callApi({
			apiPath: STATISTICS_PATH,
			params: {
				start: formatAccountTime(input.since),
				end: formatAccountTime(input.until),
				version: "2",
				limit: String(STATISTICS_PAGE_LIMIT),
			},
			method: "GET",
			label,
			// Bounded by default (see STATISTICS_TIMEOUT_MS). The caller may pass
			// its own signal to tear the request down sooner, exactly as the
			// worker's bridge does for `requestRecordingLink`.
			signal: input.signal ?? AbortSignal.timeout(STATISTICS_TIMEOUT_MS),
		});
		const envelope = assertZadarmaOk(res, json, label);
		const rowCount = countZadarmaStatisticsRows(envelope);
		const scan = scanZadarmaStatistics(envelope);
		if (rowCount === null || scan === null) {
			throw new ProviderError({
				code: "invalid_response",
				// No vendor text echoed: the body is a list of calls, numbers
				// included, and this message is destined for a log line.
				message: `${label} returned an unrecognized envelope shape`,
			});
		}
		// A FULL page is not a complete answer. The interface promises never to
		// return a partial list quietly, because a short answer reads identically
		// to "nothing is pending" — so a page at the cap fails LOUDLY instead.
		// Unreachable at one user in a 24 h window; the guard exists because the
		// signature accepts any window a caller cares to pass.
		if (rowCount >= STATISTICS_PAGE_LIMIT) {
			throw new ProviderError({
				code: "invalid_response",
				message: `${label} returned a full page (${rowCount}) — window truncated`,
			});
		}
		// Rows the mapper had to throw away (full-review F3). The mapper cannot say
		// this itself — `telephony-params-are-pure` forbids it a `console` — so the
		// vendor client, which IS allowed to log, reports it here.
		//
		// WHY IT MATTERS: a PARTIAL drift is invisible without this. The phase-1 F8
		// guard fails only when NOT ONE row is recognized; when some are, every
		// dropped row vanishes and the sweep prints `{scanned: 0}` — identical to a
		// quiet account. The id-shape case is the one to watch: the same drift is
		// LOUD on the webhook path (403 + `telephony.zadarma.malformed_id`) and was
		// mute here, so one vendor change could take out both capture routes with
		// only one of them saying so.
		//
		// BOUNDED BY CONSTRUCTION, unlike the ingress log: this fires at most once
		// per statistics call (~288/day at the 5-minute cadence) and only when
		// something was actually dropped — so it cannot become the eviction
		// primitive against Fly's ~7-day window that `INGRESS_LOG_BUDGET` and
		// `RECONCILE_LOG_BUDGET` exist to prevent. Counters only; no vendor text,
		// no ids, and therefore no phone numbers.
		const dropped =
			scan.droppedUnrecognized + scan.droppedBadId + scan.droppedNoCallId;
		if (dropped > 0) {
			console.error(
				JSON.stringify({
					ts: Date.now(),
					event: "telephony.zadarma.statistics_dropped",
					rawRows: scan.rawRows,
					usable: scan.recordings.length,
					unrecognized: scan.droppedUnrecognized,
					badId: scan.droppedBadId,
					noCallId: scan.droppedNoCallId,
				}),
			);
		}
		return scan.recordings;
	}

	/**
	 * Who the calls in `[since, until]` were with (FR-025, see
	 * `CounterpartyResolution`). The SAME request as
	 * `listRecordingsAwaitingCapture` — path, `version=2`, `limit`, the
	 * account-clock window, `assertZadarmaOk`, the full-page guard — read by a
	 * DIFFERENT mapper. Deliberately a second request per tick rather than a
	 * second output of the first: `zadarma-statistics.ts` is forbidden by its
	 * own source test to name `clid` / `destination`, and that prohibition is
	 * worth more than one cheap GET every five minutes.
	 *
	 * Everything that would fail silently here fails the same way as in the
	 * sibling: a dropped `version=2` yields rows with no `pbx_call_id`, which the
	 * mapper skips, and every conversation would then sit `pending` until it
	 * expires to `unavailable` — no error anywhere. The `null`-from-mapper and
	 * full-page cases throw for the reason the interface states: "no row for
	 * this call" is a legitimate answer, so a quietly partial list is
	 * indistinguishable from it.
	 *
	 * The response carries the other party's number and presentation name on
	 * every row. None of it is echoed into a message: the two throws below are
	 * constant text, and this method logs nothing — the resolver's run line
	 * (`telephony.counterparty.sweep`) carries the only counters.
	 */
	async resolveCounterparties(input: {
		since: Date;
		until: Date;
		signal?: AbortSignal;
	}): Promise<CounterpartyResolution[]> {
		const label = "pbx statistics request (counterparty)";
		const { res, json } = await this.callApi({
			apiPath: STATISTICS_PATH,
			params: {
				start: formatAccountTime(input.since),
				end: formatAccountTime(input.until),
				version: "2",
				limit: String(STATISTICS_PAGE_LIMIT),
			},
			method: "GET",
			label,
			signal: input.signal ?? AbortSignal.timeout(STATISTICS_TIMEOUT_MS),
		});
		const envelope = assertZadarmaOk(res, json, label);
		const rowCount = countZadarmaStatisticsRows(envelope);
		const resolutions = mapZadarmaCounterparties(envelope);
		if (rowCount === null || resolutions === null) {
			throw new ProviderError({
				code: "invalid_response",
				message: `${label} returned an unrecognized envelope shape`,
			});
		}
		if (rowCount >= STATISTICS_PAGE_LIMIT) {
			throw new ProviderError({
				code: "invalid_response",
				message: `${label} returned a full page (${rowCount}) — window truncated`,
			});
		}
		return resolutions;
	}
}
