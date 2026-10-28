/**
 * Inbound telephony webhook handlers (Phase 3 of `call-to-analysis-pipeline`;
 * vendor-neutral since `telephony-provider-zadarma`).
 *
 * Pure request→Response functions with their side-effecting collaborators
 * (`telephony`, `db`) injected — the `voice` + `recording-status` + `events`
 * `route.ts` files are thin adapters that pass the real singletons in. This
 * mirrors the F-03 `credentials-authorize.ts` ← `route.ts` split so the handlers
 * are unit-testable against stubs (see `webhooks.test.ts`) without a live libsql
 * connection.
 *
 * The signature IS the auth: these endpoints are unauthenticated at the session
 * layer (the provider has no session), so the handler verifies the signature
 * header the provider names (`telephony.signatureHeader`) before it acts. They
 * are excluded from the `proxy.ts` route gate via its `api/telephony`
 * matcher-exclusion token — which means this file, not the gate, is the only
 * authorization these paths have.
 *
 * WHERE that check sits differs by path, on purpose, and each site carries its
 * reasoning: `/voice` verifies before anything (§handleVoiceWebhook),
 * `/recording-status` + `/events` parse first and verify before the WRITE
 * (§handleRecordingStatus), and the handshake has nothing to verify at all
 * (§handleChallenge).
 */
import { type BackfillDb, backfillConversation } from "~/server/jobs/backfill";
import {
	type IngressOutcome,
	logChallengeIngress,
	logWebhookIngress,
} from "~/server/telephony/ingress-log";
import type { TelephonyProvider } from "~/server/telephony/types";

/**
 * The full external URL Twilio signed against. Behind Fly's proxy the internal
 * request host won't match what Twilio saw, so we reconstruct from
 * `PUBLIC_BASE_URL` (the public origin) + the request path. In mock/dev mode
 * `PUBLIC_BASE_URL` may be unset — fall back to the request origin (the mock
 * provider ignores the URL anyway, so dev/CI needs no secret).
 */
function baseOrigin(
	request: Request,
	publicBaseUrl: string | undefined,
): string {
	return publicBaseUrl ?? new URL(request.url).origin;
}

/** Reconstruct the exact URL Twilio computed its HMAC over (origin + path + query). */
function signedUrl(
	request: Request,
	publicBaseUrl: string | undefined,
): string {
	const u = new URL(request.url);
	return `${baseOrigin(request, publicBaseUrl)}${u.pathname}${u.search}`;
}

/**
 * Which ingress route this request actually hit.
 *
 * NOT a hardcoded literal, and that matters: `events/route.ts` RE-EXPORTS
 * `recording-status`'s `POST`, so both URLs run this same code. Naming the path
 * with a constant made a Zadarma post to `/api/telephony/events` and a Twilio
 * post to `/api/telephony/recording-status` produce byte-identical log lines —
 * which defeats the one question `ingress-log.ts` exists to answer ("is the
 * notification URL wired to the right endpoint?"): register the wrong one of the
 * two in the vendor panel and the log still looks correct (impl-review F6).
 *
 * The value comes from the URL Next.js routed, so only the three real route
 * segments can appear — but it is still allow-listed rather than trusted, since
 * it ends up in a log line alongside caller-controlled fields.
 */
const INGRESS_PATHS = ["voice", "recording-status", "events"] as const;

function ingressPath(request: Request): string {
	const segment =
		new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
	return (INGRESS_PATHS as readonly string[]).includes(segment)
		? segment
		: "(other)";
}

/** Parse the single-read form-encoded body into a flat `Record<string,string>`. */
function formParams(raw: string): Record<string, string> {
	const params: Record<string, string> = {};
	// A Request body is single-read — `.text()` is called ONCE by the caller; do
	// not also call `.formData()` (it would throw "body already read").
	for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
	return params;
}

/**
 * Largest webhook body this app will read, in bytes.
 *
 * A real telephony post is under 2 KB (Twilio's recording-status form is a few
 * hundred bytes; Zadarma's `NotifyRecord` carries three fields), so 64 KB is
 * ~32x headroom and cannot plausibly reject a genuine notification. Exported so
 * the tests assert against the same constant the handlers enforce, rather than
 * a number copied into a fixture.
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Body exceeded `MAX_WEBHOOK_BODY_BYTES`. */
function payloadTooLarge(): Response {
	return new Response("payload too large", {
		status: 413,
		headers: { "content-type": "text/plain" },
	});
}

/** The body could not be read or decoded (truncated upload, bad encoding). */
function malformedBody(): Response {
	return new Response("malformed request body", {
		status: 400,
		headers: { "content-type": "text/plain" },
	});
}

/**
 * Read the request body with a HARD byte cap, or fail with a Response.
 *
 * WHY THIS IS NOT `await request.text()` (FU-4, from the phase-3 impl review):
 * both webhook entrypoints are unauthenticated by design — the signature IS the
 * auth — and `request.text()` was the FIRST statement of each, before any check
 * of any kind. App Router Route Handlers impose no body limit (the well-known
 * 1 MB ceiling is a Server Actions limit, not a `Request.text()` one) and Fly's
 * proxy imposes none either, while `fly.toml` pins
 * `NODE_OPTIONS='--max-old-space-size=256'`. A single anonymous POST of a few
 * hundred MB therefore materializes as ONE JavaScript string and blows through
 * the V8 heap ceiling — and that is a **fatal process abort, not a catchable
 * exception**: no try/catch anywhere saves it, the Machine dies, and every
 * in-flight call is lost. There is no rate limiting on these paths (`throttle.ts`
 * covers login only), so one request is the whole attack.
 *
 * TWO LAYERS, and the header alone is NOT one of them:
 *
 *   1. `Content-Length`, when present, rejects before a single byte is read.
 *      This is a cheap fast path for an HONEST client, nothing more.
 *   2. A running total over the body stream is the actual guarantee. It has to
 *      be: a chunked request carries NO `Content-Length` at all (verified —
 *      constructing a `Request` with a `ReadableStream` body yields
 *      `content-length: null`), so a header-only guard is bypassed by simply
 *      omitting the header. A guard that an attacker opts out of is decoration.
 *
 * The FU-4 note prescribed only the header check plus a try/catch; that would
 * have shipped the bypass above. This is the deliberate widening.
 *
 * Reading stops and the stream is cancelled the moment the cap is crossed, so
 * peak memory is bounded by the cap rather than by what the caller sends.
 *
 * A rejected read (truncated upload, bad `Content-Encoding`) returns 400 rather
 * than escaping `POST` as an unhandled rejection, which surfaced as an opaque
 * 500 — the same class of defect one layer up.
 */
async function readBoundedBody(request: Request): Promise<
	| { ok: true; raw: string; bytes: number }
	| {
			ok: false;
			response: Response;
			/** Which refusal it was — carried so the caller can log it. */
			outcome: Extract<IngressOutcome, "too-large" | "unreadable">;
	  }
> {
	// Layer 1 — honest declaration. A malformed or absent header falls through to
	// layer 2 rather than being trusted or rejected: `Number.parseInt` on garbage
	// yields NaN, and `NaN > max` is false.
	const declared = Number.parseInt(
		request.headers.get("content-length") ?? "",
		10,
	);
	if (declared > MAX_WEBHOOK_BODY_BYTES) {
		return { ok: false, response: payloadTooLarge(), outcome: "too-large" };
	}

	// A bodyless request (or a GET routed here) reads as the empty string, which
	// `formParams` turns into `{}` — the pre-existing behaviour of `.text()`.
	if (!request.body) return { ok: true, raw: "", bytes: 0 };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			// Layer 2 — the real cap. Cancel rather than drain: continuing to read a
			// body we have already refused is the exact work being prevented.
			if (total > MAX_WEBHOOK_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				return { ok: false, response: payloadTooLarge(), outcome: "too-large" };
			}
			chunks.push(value);
		}
	} catch {
		// Truncated upload, bad Content-Encoding, connection reset mid-body.
		await reader.cancel().catch(() => {});
		return { ok: false, response: malformedBody(), outcome: "unreadable" };
	}

	try {
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		// `fatal: false` (the default) — a stray invalid byte becomes U+FFFD rather
		// than a 400. Telephony bodies are ASCII form-encoding; being lenient here
		// preserves the "never lose a real note" posture, and a body mangled enough
		// to matter fails signature verification anyway.
		return { ok: true, raw: new TextDecoder().decode(joined), bytes: total };
	} catch {
		return { ok: false, response: malformedBody(), outcome: "unreadable" };
	}
}

/**
 * Provider-neutral "received, nothing further" acknowledgement.
 *
 * The one hard constraint is that a webhook reply MUST carry an explicit
 * `Content-Type`: Twilio's HTTP client rejects one that lacks it with error
 * 11200 ("Response does not contain content type", surfaced as a 502 in its
 * console) even when our side processed the request fine. It does NOT require a
 * particular type — it does not parse the body of a recording-status
 * acknowledgement — so `text/plain` satisfies the real constraint for every
 * provider.
 *
 * This used to answer empty TwiML, which was one vendor's FORMAT leaking out of
 * the handler layer (it is not on the list of six leaks in the change's
 * `change.md` — it was found while implementing them). Zadarma has no TwiML and
 * posts EIGHT event types to a single account-level URL, so keeping it would
 * have answered a competitor's XML dialect to every notification it sends.
 */
function acknowledged(): Response {
	return new Response("ok", {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
}

function forbidden(): Response {
	return new Response("invalid signature", {
		status: 403,
		headers: { "content-type": "text/plain" },
	});
}

/**
 * The configured provider has no inbound voice webhook — its call scenario
 * lives on the provider's side. 404 is the honest answer: for THIS provider the
 * endpoint really does not exist. A silent 200 would make a misconfigured
 * webhook look healthy in the provider's console.
 */
function noInboundWebhook(): Response {
	return new Response("no inbound voice webhook for this provider", {
		status: 404,
		headers: { "content-type": "text/plain" },
	});
}

/**
 * The request is not this provider's URL-verification handshake — either the
 * provider runs none at all, or this GET lacks its challenge parameter. Same
 * shape and same reasoning as `noInboundWebhook()` above: 404 is the honest
 * answer for an endpoint that, for this provider, genuinely does not exist.
 */
function noChallenge(): Response {
	return new Response("no URL-verification handshake for this provider", {
		status: 404,
		headers: { "content-type": "text/plain" },
	});
}

export type VoiceWebhookDeps = {
	// `buildInboundResponse` is optional on the interface and stays optional
	// through `Pick` — a provider without an inbound voice webhook simply omits it.
	telephony: Pick<
		TelephonyProvider,
		"verifySignature" | "buildInboundResponse" | "signatureHeader"
	>;
	publicBaseUrl: string | undefined;
};

/**
 * Voice webhook (call entry). Returns the provider's dial-and-record response
 * pointing the recording callback at our `recording-status` handler, or 404 if
 * the configured provider has no inbound voice webhook. No DB writes here.
 */
export async function handleVoiceWebhook(
	request: Request,
	deps: VoiceWebhookDeps,
): Promise<Response> {
	const body = await readBoundedBody(request);
	if (!body.ok) {
		// Refused before parsing, so there is no event name to report.
		logWebhookIngress({
			path: ingressPath(request),
			kind: "",
			bodyBytes: 0,
			signed: false,
			outcome: body.outcome,
		});
		return body.response;
	}
	const params = formParams(body.raw);
	// Header NAME comes from the provider — the handler must not know which
	// vendor it is fronting. A missing header stays an empty string, which
	// `verifySignature` refuses (fail-closed), same as before.
	const signature = request.headers.get(deps.telephony.signatureHeader) ?? "";

	// One helper so every exit below reports the same request facts and only the
	// outcome varies. `kind` stays empty on this path ON PURPOSE: unlike the
	// recording-status path there is no vendor-neutral parse of a voice webhook,
	// so the only way to name the event would be to read a vendor's form field
	// here — putting back exactly the leak `types.ts` exists to prevent. The
	// outcome alone answers the question this path is instrumented for ("is
	// anything still pointed at /voice?").
	const log = (outcome: IngressOutcome): void =>
		logWebhookIngress({
			path: ingressPath(request),
			kind: "",
			bodyBytes: body.bytes,
			signed: signature.length > 0,
			outcome,
		});

	if (
		!deps.telephony.verifySignature({
			signature,
			url: signedUrl(request, deps.publicBaseUrl),
			params,
		})
	) {
		log("forbidden");
		return forbidden();
	}

	// Deliberately AFTER signature verification. Checking method-presence first
	// would be a fraction of a millisecond cheaper and would turn this endpoint
	// into an oracle: an unauthenticated caller could distinguish 404 from 403
	// and learn which provider is configured, without ever holding a valid
	// signature. Security beats the micro-optimization — this ordering is a
	// decision, not an oversight.
	//
	// It is also the OPPOSITE of the order in `handleRecordingStatus` below, and
	// that asymmetry is intended, not drift. This path has exactly one caller
	// shape (a provider that generates a per-call scenario, i.e. Twilio) and every
	// request to it is meant to be signed, so verifying first costs nothing. That
	// path receives a whole multi-event stream on one URL, of which only one event
	// is signed with a recipe we know — see the note there.
	if (!deps.telephony.buildInboundResponse) {
		log("unsupported");
		return noInboundWebhook();
	}

	const inbound = deps.telephony.buildInboundResponse({
		recordingStatusCallbackUrl: `${baseOrigin(request, deps.publicBaseUrl)}/api/telephony/recording-status`,
	});
	log("answered");
	return new Response(inbound.body, {
		status: 200,
		// Content type comes from the provider — the handler does not parse the
		// format and has no business naming it.
		headers: { "content-type": inbound.contentType },
	});
}

export type RecordingStatusDeps = {
	telephony: Pick<
		TelephonyProvider,
		"verifySignature" | "parseRecordingEvent" | "signatureHeader"
	>;
	// Only the transaction entrypoint is needed — the structural narrow keeps the
	// handler tests free of a real libsql client (mirrors `LockoutDb`). Taken from
	// the shared write path rather than re-narrowed here, so the two callers of
	// `backfillConversation` cannot drift apart on what a `db` even is.
	db: BackfillDb;
	publicBaseUrl: string | undefined;
	userId: string;
	/**
	 * Phase 4 fast-path: fire-and-forget the worker for a freshly-created job, so
	 * processing starts immediately instead of waiting up to one poll interval.
	 * Optional + injected — the unit/integration tests omit it (the poller would
	 * drain the job anyway). It funnels through the worker's atomic claim, so the
	 * poller and this kickoff can never both process the same job.
	 */
	kickoff?: (jobId: string) => void;
};

/**
 * Recording-status webhook (job ingress) — reached via BOTH `/api/telephony/
 * recording-status` (a per-call callback URL the provider is told) and
 * `/api/telephony/events` (a single account-level notification URL), which
 * re-exports the same route handler.
 *
 * On a `completed` recording it durably creates the conversation + a `pending`
 * job (idempotent on `(user_id, call_sid)`) and returns 200 fast. STT/LLM (tens
 * of seconds) MUST NOT run here: providers time out on the order of seconds and
 * retry (Twilio ~15 s, ≤3×), and those retries are absorbed as no-ops by the
 * idempotency index — which for a provider that signs no URL, timestamp or nonce
 * is a security control, not an optimization.
 *
 * `kickoff` is the fire-and-forget fast path for a freshly-created job; it is
 * optional, so the poller drains the job when a caller omits it.
 */
export async function handleRecordingStatus(
	request: Request,
	deps: RecordingStatusDeps,
): Promise<Response> {
	// Bounded read BEFORE anything else — see `readBoundedBody`. This is strictly
	// upstream of the authorization ordering discussed below and does not disturb
	// it: it is a pure request-SHAPE check with no side effect and no dependence
	// on the body's contents.
	const body = await readBoundedBody(request);
	if (!body.ok) {
		// Refused before parsing, so there is no event name to report.
		logWebhookIngress({
			path: ingressPath(request),
			kind: "",
			bodyBytes: 0,
			signed: false,
			outcome: body.outcome,
		});
		return body.response;
	}
	const params = formParams(body.raw);
	const event = deps.telephony.parseRecordingEvent(params);

	// Provider-named header, read here rather than at its use below only so the
	// log can report presence on every exit. Reading a header has no side effect
	// and no dependence on the body, so it does not disturb the authorization
	// ordering discussed next. A header the request does not carry stays an empty
	// string, which `verifySignature` refuses (fail-closed).
	const signature = request.headers.get(deps.telephony.signatureHeader) ?? "";

	// One line per request, whatever happens to it. This is the observability the
	// Zadarma cutover proved was missing: seven of eight event types no-op at 200
	// with nothing written anywhere, so "the provider sends nothing" and "the
	// provider sends everything except the recording event" both presented as
	// silence, and telling them apart cost a live call per guess.
	//
	// `event.recordingStatus` is the vendor-neutral status, which for a
	// non-actionable event IS the provider's own lowercased event name — the one
	// fact that settles the question. It is caller-controlled, so it goes through
	// `token()` in the logger; the body is reported as a byte COUNT, never as
	// content; the signature as presence, never as a value. The per-window budget
	// there is what keeps this from being an eviction primitive against Fly's
	// ~7-day log window (see the header of `ingress-log.ts`).
	const log = (outcome: IngressOutcome): void =>
		logWebhookIngress({
			path: ingressPath(request),
			kind: event.recordingStatus,
			bodyBytes: body.bytes,
			signed: signature.length > 0,
			outcome,
		});

	// AUTHORIZATION ORDER: parse first, verify before the WRITE — the reverse of
	// the `/voice` path above, and a decision, not drift (FU-3 / phase-3
	// criterion 3.7 of `telephony-provider-zadarma`).
	//
	// Only a finished recording is acted on; every other lifecycle event is a
	// fast no-op, and that no-op is now reached WITHOUT a signature check. It has
	// to be: a provider may post many event types to one URL and sign only the
	// one it documents. Zadarma does exactly that — a single account-level
	// notification URL receiving eight event types, of which
	// `verifyZadarmaWebhookSignature` knows the signed field set of NOTIFY_RECORD
	// alone. Verifying first therefore answered 403 to the other seven, on every
	// single call, and a permanent 403 storm is indistinguishable from the
	// broken-HMAC symptom the migration's live-run criterion watches for.
	//
	// WHAT MAKES THIS SAFE is the shape of the branch, not the provider: it
	// returns before any PERSISTENT side effect — no DB write, no kickoff, not
	// even an `env` read. It DOES now emit one log line (it used to emit none),
	// and that is the single deliberate exception: without it this branch is
	// where a capture outage goes to hide. What keeps the exception from being
	// the very hazard this paragraph guards against is that the line is
	// content-sanitized and drawn from a per-window budget — see the header of
	// `ingress-log.ts`, which is where that reasoning lives in full.
	// `parseRecordingEvent` is pure in every
	// implementation (`twilio-params.ts`, `zadarma-params.ts`) and MUST STAY pure:
	// the moment it logs or writes, this ordering hands an anonymous caller a
	// side-effect primitive. That is enforced mechanically by the
	// `telephony-params-are-pure` rule in `.dependency-cruiser.cjs`, not by this
	// comment. The write path below stays fail-closed — the signature is required
	// before a single row is touched.
	//
	// TWO COSTS, both accepted rather than absent (impl-review phase 3, F1/F4):
	//   1. ✅ CLOSED by FU-4 (2026-09-07). The body is still read before any of
	//      this, but it is no longer UNBOUNDED: `readBoundedBody` caps it at
	//      `MAX_WEBHOOK_BODY_BYTES` over the stream itself, so the work an
	//      anonymous caller can force is a pure function call plus at most 64 KB
	//      of reading. Previously this was `request.text()` with no ceiling.
	//   2. The response now varies with a body the caller controls: a
	//      non-actionable event answers 200 where an unsigned actionable one
	//      answers 403. That is a weak provider-fingerprinting oracle — the very
	//      leak `handleVoiceWebhook` above refuses to create on ITS path. Accepted
	//      here because the alternative is a 403 on every ordinary lifecycle event
	//      of every call, which is indistinguishable from a broken HMAC recipe and
	//      would bury the one signal the live-run criterion depends on. Provider
	//      identity is low-value; a silent capture outage is not.
	//
	// THE FORBIDDEN ALTERNATIVE, rejected in phase 2 and recorded here because
	// this is where it would be re-invented: making the provider return `true`
	// from `verifySignature` for events it cannot verify. That re-creates the
	// fail-open gap in Zadarma's own SDK which `zadarma-signature.ts` exists to
	// close, and it fails open for a forged NOTIFY_RECORD too — the one event
	// that writes.
	if (event.recordingStatus !== "completed") {
		log("ignored");
		return acknowledged();
	}

	if (
		!deps.telephony.verifySignature({
			signature,
			url: signedUrl(request, deps.publicBaseUrl),
			params,
		})
	) {
		log("forbidden");
		return forbidden();
	}

	// Defensive: a completed recording always carries both SIDs. A blank `call_sid`
	// would defeat the partial-unique idempotency index (it is NOT NULL), so treat
	// a malformed event as a no-op rather than landing a un-deduplicable row.
	if (!event.callSid || !event.recordingSid) {
		log("incomplete");
		return acknowledged();
	}

	// ONE shared write path with the reconcile sweep (`jobs/backfill.ts`) — the
	// conflict clause it carries is the replay defense for a vendor that signs no
	// URL, timestamp or nonce, so it must not exist twice.
	const newJobId = await backfillConversation(deps.db, {
		userId: deps.userId,
		callSid: event.callSid,
		recordingSid: event.recordingSid,
		startedAt: event.startedAt,
		endedAt: event.endedAt,
		durationMs: event.recordingDurationMs,
	});

	// Fast-path: start the worker immediately for the new job (Phase 4). Only on
	// the new-conversation path — a retried-webhook no-op leaves `newJobId` null.
	// Fire-and-forget AFTER the transaction commits so the claim sees the row.
	if (newJobId) deps.kickoff?.(newJobId);

	// `duplicate` is the replay case the idempotency index absorbs — for a
	// provider that signs no URL, timestamp or nonce that index is a security
	// control, so its hits are worth seeing rather than being silent.
	log(newJobId ? "enqueued" : "duplicate");
	return acknowledged();
}

export type ChallengeDeps = {
	// `handleChallenge` is optional on the interface and stays optional through
	// `Pick` — a provider with no URL-verification handshake simply omits it.
	telephony: Pick<TelephonyProvider, "handleChallenge">;
};

/**
 * URL-verification handshake (a GET on the events endpoint).
 *
 * Some providers refuse to SAVE a notification URL until it proves it is ours by
 * echoing a challenge value they put in the query string. Zadarma's is
 * `?zd_echo=<random>`; the provider owns the parameter name and the exact bytes
 * of the reply, this handler owns only the HTTP shape.
 *
 * UNAUTHENTICATED BY CONSTRUCTION, and that is not a gap: the handshake is how
 * the provider verifies US, before it has ever signed anything. Two consequences
 * are load-bearing rather than incidental:
 *
 *   1. NO UNBOUNDED SIDE EFFECT is permitted here — no DB access, and nothing
 *      whose cost grows with how often it is called. Anyone on the internet can
 *      call this as often as they like. This used to read "no logging, no
 *      counter" outright; it now emits one budgeted line via
 *      `logChallengeIngress` so a handshake the provider re-runs is visible at
 *      all, and the budget is what preserves the property the stricter wording
 *      was protecting. The challenge VALUE is still never logged.
 *   2. It REFLECTS caller-controlled content, so the media type matters. The
 *      BODY passes through untouched — a trimmed or re-wrapped echo simply fails
 *      the provider's exact-equality check, and its only symptom is "the URL will
 *      not save in their panel", with nothing at all in our logs. The CONTENT
 *      TYPE is clamped to text/plain and `nosniff` is added, so no provider
 *      implementation can turn this endpoint into one that serves markup.
 *
 * Absent method or `null` → 404, the same idiom (and the same honesty) as
 * `handleVoiceWebhook`'s missing `buildInboundResponse`.
 */
export function handleChallenge(
	request: Request,
	deps: ChallengeDeps,
): Response {
	const answer = deps.telephony.handleChallenge?.(new URL(request.url));
	logChallengeIngress({ matched: Boolean(answer) });
	if (!answer) return noChallenge();

	// Defense in depth on the media type (impl-review phase 3, F5). The provider
	// owns the bytes; it does NOT get to make this endpoint serve markup. Today
	// every implementation declares `text/plain`, so this clamp is inert — but the
	// interface (`types.ts`) accepts any string, and a provider declaring
	// `text/html` would turn a reflection of caller-controlled content into stored
	// XSS on the app's own origin, where `nosniff` cannot help: nosniff stops a
	// browser GUESSING html, not a server DECLARING it. Anything that is not
	// text/plain (bare or with parameters) is served as text/plain instead.
	const contentType = /^text\/plain\s*(?:;|$)/i.test(answer.contentType)
		? answer.contentType
		: "text/plain";

	return new Response(answer.body, {
		status: 200,
		headers: {
			"content-type": contentType,
			"x-content-type-options": "nosniff",
		},
	});
}
