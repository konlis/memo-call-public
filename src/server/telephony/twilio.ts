import twilio from "twilio";

import { ProviderError } from "~/server/_lib/provider-error";
import { parseRecordingEventParams } from "~/server/telephony/twilio-params";
import type {
	RecordingEvent,
	TelephonyProvider,
	WebhookSignatureInput,
} from "~/server/telephony/types";

export type TwilioConfig = {
	accountSid?: string;
	authToken?: string;
	region?: string;
	edge?: string;
	forwardNumber?: string;
	/**
	 * Outbound caller-id DID, used as `From` on `placeCall`. NOT in the
	 * constructor's required-field guard — it is an outbound-only credential, and
	 * coupling it to construction would crash the live INBOUND path at boot when
	 * the secret is unset (F1). Validated lazily inside `placeCall` instead.
	 */
	callerId?: string;
};

/**
 * Region-portable Twilio REST host. US1 (default) is `api.twilio.com`; a
 * configured region (e.g. `ie1`) yields `api.ie1.twilio.com`, optionally edged
 * (`api.<edge>.ie1.twilio.com`). This is the single place region lives, so a
 * US1→IE1 migration is an env flip (`TWILIO_REGION`) with zero code change.
 */
function apiHost(region?: string, edge?: string): string {
	if (!region) return "api.twilio.com";
	return edge ? `api.${edge}.${region}.twilio.com` : `api.${region}.twilio.com`;
}

function statusToCode(status: number): "auth" | "transport" {
	return status === 401 || status === 403 ? "auth" : "transport";
}

/**
 * Real Twilio capture provider. All of region/edge/credentials/forward-number
 * come from env (never hardcoded). Signature verification and TwiML generation
 * use the SDK's pure helpers (`validateRequest`, `twiml.VoiceResponse`). The
 * recording media pull + delete go through raw authenticated REST against the
 * region-derived host — the SDK can't stream a media body without buffering it,
 * which the 256 MB Fly Machine forbids; raw `fetch().body.pipeTo(sink)` streams.
 */
/**
 * The recording representation this provider pulls — extension AND media type
 * as ONE value, so they cannot drift apart (FU-1, review of phase 2 / F2).
 *
 * These used to be two independent literals coupled only by a comment:
 * `recordingContentType = "audio/wav"` on the class, and a separate `"wav"`
 * passed to `recordingUrl` at the fetch site. For Twilio both happened to be
 * right, so nothing was broken — but nothing would have noticed if they stopped
 * agreeing either. The declared type is not cosmetic: the job layer forwards it
 * verbatim as the Content-Type of the upload to Deepgram (`worker.ts`), so
 * fetching `.mp3` while announcing `audio/wav` mislabels the STT request. That
 * failure is silent at every layer we control — the extension is a URL segment
 * and the MIME is a string, so neither the type system nor any existing test
 * relates them.
 *
 * `as const` is load-bearing: it makes `ext` a literal type, which is what lets
 * `recordingUrl`'s parameter be typed from this value instead of restating
 * `"wav"`. Changing the format here updates the URL, the parameter type and the
 * declared MIME in one edit — that is the point. It does NOT silently update the
 * tests: `twilio.test.ts`'s happy path pins `.wav` explicitly and will fail,
 * which is intended (a format switch should be a deliberate, reviewed change,
 * not an incidental one). The FU-1 coupling test alongside it passes on any
 * CONSISTENT change and fails on a divergent one — it guards the relationship,
 * not the format. Verified by mutation 2026-09-07.
 *
 * NOT a general format-negotiation seam. Twilio serves several representations;
 * we deliberately pull one. Making this configurable would hand callers a way to
 * pick a format the STT provider has not been validated against.
 */
const RECORDING_MEDIA = { ext: "wav", mime: "audio/wav" } as const;

export class TwilioTelephonyProvider implements TelephonyProvider {
	private readonly accountSid: string;
	private readonly authToken: string;
	private readonly forwardNumber: string;
	/**
	 * Outbound-only; may be undefined at construction (inbound must keep booting
	 * without it — F1). `placeCall` validates it lazily before any REST call.
	 */
	private readonly callerId?: string;
	private readonly host: string;

	/** Twilio signs with `X-Twilio-Signature`; lowercase per the interface contract. */
	readonly signatureHeader = "x-twilio-signature";

	/**
	 * Declared media type of the bytes `streamRecording` yields. Derived from
	 * `RECORDING_MEDIA` — see the note there for why this is not its own literal.
	 */
	readonly recordingContentType = RECORDING_MEDIA.mime;

	constructor(config: TwilioConfig) {
		const missing = (["accountSid", "authToken", "forwardNumber"] as const)
			.filter((k) => !config[k])
			.join(", ");
		if (missing) {
			// Loud failure at construction, mirroring the STT/LLM real-branch
			// "throws auth" pattern — never a silent fallback to mock.
			throw new ProviderError({
				code: "auth",
				message: `twilio telephony provider misconfigured — missing: ${missing}`,
			});
		}
		// Non-null asserted: the guard above proves all three are present.
		this.accountSid = config.accountSid as string;
		this.authToken = config.authToken as string;
		this.forwardNumber = config.forwardNumber as string;
		// callerId is intentionally NOT in the guard — outbound-only (see TwilioConfig).
		this.callerId = config.callerId;
		this.host = apiHost(config.region, config.edge);
	}

	private get authHeader(): string {
		const basic = Buffer.from(`${this.accountSid}:${this.authToken}`).toString(
			"base64",
		);
		return `Basic ${basic}`;
	}

	/**
	 * Twilio addresses a recording's REPRESENTATION by file extension. `ext` is
	 * therefore a content negotiation, not a filename: `RECORDING_MEDIA.ext` for
	 * the audio bytes, `"json"` for the metadata resource.
	 */
	private recordingUrl(
		recordingSid: string,
		ext: typeof RECORDING_MEDIA.ext | "json",
	): string {
		return `https://${this.host}/2010-04-01/Accounts/${this.accountSid}/Recordings/${recordingSid}.${ext}`;
	}

	verifySignature(input: WebhookSignatureInput): boolean {
		// Fail-closed. Twilio's signature is an HMAC over the full URL, so a URL
		// we cannot parse is a signature we cannot check. The SDK carries no
		// guard of its own — `validateRequest` runs `new URL(url)` as its first
		// statement, so an absent OR unparseable value throws `TypeError: Invalid
		// URL` (measured against the installed SDK, not assumed) and would
		// surface as a 500 rather than a refusal. The signature is the ONLY
		// authorization a webhook has (no session), so BOTH cases must REFUSE —
		// this is what makes the interface's "never throws, never fail-open"
		// contract true here. `url` is optional on that shared contract because
		// other providers sign only body fields.
		if (!input.url || !URL.canParse(input.url)) return false;
		return twilio.validateRequest(
			this.authToken,
			input.signature,
			input.url,
			input.params,
		);
	}

	buildInboundResponse(input: { recordingStatusCallbackUrl: string }): {
		body: string;
		contentType: string;
	} {
		const response = new twilio.twiml.VoiceResponse();
		const dial = response.dial({
			record: "record-from-answer-dual",
			recordingStatusCallback: input.recordingStatusCallbackUrl,
			recordingStatusCallbackEvent: ["completed"],
		});
		dial.number(this.forwardNumber);
		// TwiML is served as text/xml — the value the handler used to hardcode.
		return { body: response.toString(), contentType: "text/xml" };
	}

	parseRecordingEvent(params: Record<string, string>): RecordingEvent {
		return parseRecordingEventParams(params);
	}

	async placeCall(input: {
		to: string;
		recordingStatusCallbackUrl: string;
	}): Promise<{ callSid: string }> {
		// Lazy validation: callerId is outbound-only, so it isn't a construction
		// requirement (inbound boots without it — F1). Fail loud + audited the
		// moment outbound is actually invoked, BEFORE any REST call.
		if (!this.callerId) {
			throw new ProviderError({
				code: "auth",
				message: "twilio outbound requires TWILIO_CALLER_ID",
			});
		}
		// Inline bridge TwiML — mirrors buildInboundResponse attribute-for-attribute,
		// but dials the RECIPIENT (input.to) instead of the forward number. On the
		// user answering their GSM (the `To` of the REST Calls.create below), Twilio
		// executes this TwiML, dials the recipient, and records dual-channel once
		// the recipient answers.
		const response = new twilio.twiml.VoiceResponse();
		const dial = response.dial({
			record: "record-from-answer-dual",
			recordingStatusCallback: input.recordingStatusCallbackUrl,
			recordingStatusCallbackEvent: ["completed"],
		});
		dial.number(input.to);
		const twimlString = response.toString();

		// To = the user's own GSM (rung first); From = the Twilio-owned DID.
		// Getting this backwards (To = recipient) would skip the user's leg.
		const body = new URLSearchParams({
			To: this.forwardNumber,
			From: this.callerId,
			Twiml: twimlString,
		});

		let res: Response;
		try {
			res = await fetch(
				`https://${this.host}/2010-04-01/Accounts/${this.accountSid}/Calls.json`,
				{
					method: "POST",
					headers: {
						Authorization: this.authHeader,
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body,
				},
			);
		} catch (cause) {
			throw new ProviderError({
				code: "transport",
				message: "outbound call create failed",
				cause,
			});
		}
		if (!res.ok) {
			throw new ProviderError({
				code: statusToCode(res.status),
				message: `outbound call create returned ${res.status}`,
			});
		}
		let sid: unknown;
		try {
			sid = ((await res.json()) as { sid?: unknown }).sid;
		} catch (cause) {
			throw new ProviderError({
				code: "invalid_response",
				message: "outbound call create returned unparseable JSON",
				cause,
			});
		}
		if (typeof sid !== "string" || sid.length === 0) {
			throw new ProviderError({
				code: "invalid_response",
				message: "outbound call create response missing sid",
			});
		}
		return { callSid: sid };
	}

	async streamRecording(
		input: { recordingSid: string },
		sink: WritableStream<Uint8Array>,
		opts?: { signal?: AbortSignal },
	): Promise<void> {
		let res: Response;
		try {
			res = await fetch(
				this.recordingUrl(input.recordingSid, RECORDING_MEDIA.ext),
				{
					headers: { Authorization: this.authHeader },
				},
			);
		} catch (cause) {
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
		// Streams straight through — never materializes the WAV on the heap.
		// `signal` lets the worker's bridge tear the pull down once STT settles
		// (worker F1). pipeTo rejects with the raw underlying stream error (TypeError
		// / DOMException) on a mid-download drop, or with the signal's `reason` (a
		// ProviderError) on a teardown abort; remap the former to ProviderError and
		// pass the latter through so the whole method honors the discriminator the
		// job worker switches on.
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
		let res: Response;
		try {
			res = await fetch(this.recordingUrl(input.recordingSid, "json"), {
				method: "DELETE",
				headers: { Authorization: this.authHeader },
			});
		} catch (cause) {
			throw new ProviderError({
				code: "transport",
				message: "recording delete failed",
				cause,
			});
		}
		// Idempotent: an already-deleted recording (404) is success (FR-002).
		if (res.status === 404) return;
		if (!res.ok) {
			throw new ProviderError({
				code: statusToCode(res.status),
				message: `recording delete returned ${res.status}`,
			});
		}
	}
}
