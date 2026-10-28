import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// `conversations` is imported as a runtime VALUE so the stub tx can branch on
// `table === conversations` by reference equality (same module instance the
// handler imports). Schema is a pure module (no DB connection), unlike
// `~/server/db`, which webhooks.ts imports only as a TYPE.
import { conversations } from "~/server/db/schema";
import { _resetIngressLogStateForTests } from "~/server/telephony/ingress-log";
import type { RecordingEvent } from "~/server/telephony/types";
import {
	handleChallenge,
	handleRecordingStatus,
	handleVoiceWebhook,
	MAX_WEBHOOK_BODY_BYTES,
	type RecordingStatusDeps,
} from "./webhooks";

const ORIGIN = "https://your-app.fly.dev";

/**
 * The header the stub providers below declare. The handlers read the NAME off
 * the provider (`telephony.signatureHeader`), so this constant is what the
 * request and the stub must agree on — not a value baked into the handler.
 */
const SIG_HEADER = "x-twilio-signature";

function makeRequest(
	path: string,
	body: Record<string, string>,
	signature: string | null = "sig",
	headerName: string = SIG_HEADER,
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
	};
	if (signature !== null) headers[headerName] = signature;
	return new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers,
		body: new URLSearchParams(body).toString(),
	});
}

/**
 * Stub `db` whose `transaction` runs the callback against a fake tx. Each call
 * consumes the next flag from `conflicts` — `true` makes the conversation insert
 * `.returning()` resolve to `[]` (a retried-webhook conflict), `false` resolves
 * to one row (newly created). Captures conversation + job insert values.
 *
 * `select` answers the tombstone lookup `backfillConversation` now opens the
 * transaction with (full-review F1) and resolves EMPTY here — "this call was
 * never deleted" — so every pre-existing assertion in this file keeps meaning
 * what it meant. The buried case is deliberately NOT stubbed: it is driven
 * against real libsql in `webhooks.integration.test.ts`, because a stub that
 * returns whatever the test tells it to cannot prove the SQL is well-formed
 * (CLAUDE.md "Lessons", "a stub-db unit test structurally cannot catch malformed SQL").
 */
function makeDb(conflicts: boolean[]) {
	let call = 0;
	const convInsert = vi.fn();
	const jobInsert = vi.fn();
	const transaction = vi.fn(
		async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
			const conflict = conflicts[call++] ?? false;
			const tx = {
				select() {
					return {
						from: () => ({
							where: () => ({ limit: async () => [] }),
						}),
					};
				},
				insert(table: unknown) {
					if (table === conversations) {
						return {
							values(values: unknown) {
								convInsert(values);
								return {
									onConflictDoNothing: () => ({
										returning: async () => (conflict ? [] : [{ id: "conv-1" }]),
									}),
								};
							},
						};
					}
					return {
						values(values: unknown) {
							jobInsert(values);
							return Promise.resolve();
						},
					};
				},
			};
			return cb(tx);
		},
	);
	const db = { transaction } as unknown as RecordingStatusDeps["db"];
	return { db, transaction, convInsert, jobInsert };
}

const COMPLETED = {
	CallSid: "CA123",
	RecordingSid: "RE123",
	RecordingStatus: "completed",
	RecordingDuration: "42",
};

function parseRecordingEvent(params: Record<string, string>): RecordingEvent {
	const dur = Number(params.RecordingDuration);
	return {
		callSid: params.CallSid ?? "",
		recordingSid: params.RecordingSid ?? "",
		recordingStatus: (params.RecordingStatus ?? "").toLowerCase(),
		recordingDurationMs: Number.isFinite(dur) ? dur * 1000 : undefined,
	};
}

function recordingDeps(
	t: ReturnType<typeof makeDb>,
	verify: () => boolean,
	signatureHeader: string = SIG_HEADER,
): RecordingStatusDeps {
	return {
		telephony: {
			signatureHeader,
			verifySignature: verify,
			parseRecordingEvent,
		},
		db: t.db,
		publicBaseUrl: ORIGIN,
		userId: "me",
	};
}

describe("handleVoiceWebhook", () => {
	test("403 on signature mismatch", async () => {
		const buildInboundResponse = vi.fn();
		const res = await handleVoiceWebhook(
			makeRequest("/api/telephony/voice", { CallSid: "CA1" }),
			{
				telephony: {
					signatureHeader: SIG_HEADER,
					verifySignature: () => false,
					buildInboundResponse,
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(res.status).toBe(403);
		expect(buildInboundResponse).not.toHaveBeenCalled();
	});

	test("valid signature returns the provider's body + content type", async () => {
		const verifySignature = vi.fn(() => true);
		const buildInboundResponse = vi.fn(() => ({
			body: "<Response/>",
			contentType: "text/xml",
		}));
		const res = await handleVoiceWebhook(
			makeRequest("/api/telephony/voice", { CallSid: "CA1" }),
			{
				telephony: {
					signatureHeader: SIG_HEADER,
					verifySignature,
					buildInboundResponse,
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/xml");
		expect(await res.text()).toBe("<Response/>");
		// URL is reconstructed from publicBaseUrl, not the request host.
		expect(verifySignature).toHaveBeenCalledWith(
			expect.objectContaining({ url: `${ORIGIN}/api/telephony/voice` }),
		);
		expect(buildInboundResponse).toHaveBeenCalledWith({
			recordingStatusCallbackUrl: `${ORIGIN}/api/telephony/recording-status`,
		});
	});

	// The content type is now the PROVIDER's to name, not the handler's. A
	// foreign value is the only thing that can catch a handler that re-hardcodes
	// "text/xml" — with the real value the two are indistinguishable.
	test("content type comes from the provider, not the handler", async () => {
		const res = await handleVoiceWebhook(
			makeRequest("/api/telephony/voice", { CallSid: "CA1" }),
			{
				telephony: {
					signatureHeader: SIG_HEADER,
					verifySignature: () => true,
					buildInboundResponse: () => ({
						body: "{}",
						contentType: "application/x-provider-declared",
					}),
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe(
			"application/x-provider-declared",
		);
	});

	// A provider WITHOUT an inbound voice webhook (its call scenario lives in the
	// vendor's panel) — 404, not a silent 200 that would make a misconfigured
	// webhook look healthy in the vendor's console.
	test("404 when the provider has no buildInboundResponse", async () => {
		const res = await handleVoiceWebhook(
			makeRequest("/api/telephony/voice", { CallSid: "CA1" }),
			{
				telephony: {
					signatureHeader: SIG_HEADER,
					verifySignature: () => true,
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toBe("text/plain");
	});

	// ORDER IS THE CONTRACT: signature verification runs BEFORE the
	// method-presence check, so an unauthenticated caller gets 403 and cannot
	// distinguish it from 404 to learn which provider is configured. Swapping the
	// two checks turns this endpoint into a provider-identity oracle.
	test("invalid signature on a provider WITHOUT the method still 403s, not 404", async () => {
		const res = await handleVoiceWebhook(
			makeRequest("/api/telephony/voice", { CallSid: "CA1" }),
			{
				telephony: {
					signatureHeader: SIG_HEADER,
					verifySignature: () => false,
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(res.status).toBe(403);
	});

	// The header NAME is provider config, not handler knowledge. A handler that
	// re-hardcodes `x-twilio-signature` still passes every other test here (the
	// stub provider happens to use that name) — it would read an empty signature
	// for any other provider and 403 every one of its webhooks. Only a stub that
	// declares a DIFFERENT header can catch that.
	test("reads the signature from the header the provider names", async () => {
		const verifySignature = vi.fn(() => true);
		await handleVoiceWebhook(
			makeRequest(
				"/api/telephony/voice",
				{ CallSid: "CA1" },
				"other-sig",
				"x-other-signature",
			),
			{
				telephony: {
					signatureHeader: "x-other-signature",
					verifySignature,
					buildInboundResponse: vi.fn(() => ({
						body: "<Response/>",
						contentType: "text/xml",
					})),
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(verifySignature).toHaveBeenCalledWith(
			expect.objectContaining({ signature: "other-sig" }),
		);
	});
});

describe("handleRecordingStatus", () => {
	test("403 on signature mismatch — no DB write", async () => {
		const t = makeDb([]);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			recordingDeps(t, () => false),
		);
		expect(res.status).toBe(403);
		expect(t.transaction).not.toHaveBeenCalled();
	});

	// The header-ABSENT branch, distinct from the mismatch branch above — the
	// two 403 tests here both SEND a header. It matters more now that the header
	// name is provider-supplied: a provider naming a header the request never
	// carries lands exactly here. `get` returns null, the handler substitutes
	// "", and verification refuses. That is the fail-closed contract this
	// unauthenticated endpoint rests on, and nothing else pinned it.
	test("missing signature header ⇒ empty signature, 403, no DB write", async () => {
		const t = makeDb([]);
		const verifySignature = vi.fn(() => false);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED, null),
			recordingDeps(t, verifySignature),
		);
		expect(verifySignature).toHaveBeenCalledWith(
			expect.objectContaining({ signature: "" }),
		);
		expect(res.status).toBe(403);
		expect(t.transaction).not.toHaveBeenCalled();
	});

	// Mirrors the same assertion on the /voice path. `url` is OPTIONAL on
	// WebhookSignatureInput, so the compiler no longer catches a caller that
	// stops passing it — dropping it from handleRecordingStatus would typecheck
	// and pass every other test here, while 403-ing every real recording
	// callback in production. Fail-closed, so not a breach, but a silent and
	// total capture outage whose only signal lives in the provider's console.
	// This assertion is the only thing pinning it on this ingress path.
	test("signs against the reconstructed public URL, not the request host", async () => {
		const t = makeDb([false]);
		const verifySignature = vi.fn(() => true);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			recordingDeps(t, verifySignature),
		);
		expect(verifySignature).toHaveBeenCalledWith(
			expect.objectContaining({
				url: `${ORIGIN}/api/telephony/recording-status`,
			}),
		);
	});

	// Twin of the /voice assertion — the same reason it exists there (F2): each
	// ingress path reads the header independently, so one path's pin proves
	// nothing about the other.
	test("reads the signature from the header the provider names", async () => {
		const t = makeDb([false]);
		const verifySignature = vi.fn(() => true);
		await handleRecordingStatus(
			makeRequest(
				"/api/telephony/recording-status",
				COMPLETED,
				"other-sig",
				"x-other-signature",
			),
			recordingDeps(t, verifySignature, "x-other-signature"),
		);
		expect(verifySignature).toHaveBeenCalledWith(
			expect.objectContaining({ signature: "other-sig" }),
		);
	});

	test("non-completed event is a 200 no-op (no DB write)", async () => {
		const t = makeDb([]);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", {
				...COMPLETED,
				RecordingStatus: "in-progress",
			}),
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(200);
		// Must carry a Content-Type or Twilio rejects the reply (error 11200) —
		// but NOT TwiML: the acknowledgement is provider-neutral now, and Zadarma
		// receives one of these for seven of its eight event types.
		expect(res.headers.get("content-type")).toBe("text/plain");
		// `toBe`, not `not.toContain("<Response>")` — the negative form was
		// trivially satisfied by any short body and would have stayed green
		// through almost any regression (impl-review phase 3, F10).
		expect(await res.text()).toBe("ok");
		expect(t.transaction).not.toHaveBeenCalled();
	});

	// Criterion 3.7 / FU-3, handler half. A provider may post many event types to
	// ONE account-level URL and sign only the one it documents, so a non-actionable
	// event must not be gated on a signature the provider never computed — else it
	// 403s on every call and the storm is read as a broken HMAC recipe. The Zadarma
	// half of this criterion is in `webhooks.integration.test.ts`, driven against
	// the REAL provider; this half pins the ordering itself.
	test("non-completed event is a 200 no-op WITHOUT consulting the signature", async () => {
		const t = makeDb([]);
		const verifySignature = vi.fn(() => false);
		const res = await handleRecordingStatus(
			makeRequest(
				"/api/telephony/recording-status",
				{ ...COMPLETED, RecordingStatus: "in-progress" },
				null,
			),
			recordingDeps(t, verifySignature),
		);
		expect(res.status).toBe(200);
		expect(verifySignature).not.toHaveBeenCalled();
		expect(t.transaction).not.toHaveBeenCalled();
	});

	// The other side of the same reordering: relaxing the non-actionable branch
	// must NOT relax the write path. A refused signature on a `completed` event is
	// still a 403 with no DB touch (asserted above too) — this asserts the pairing
	// explicitly, because the failure mode of getting this wrong is silent: forged
	// recordings would enter the pipeline and look exactly like real ones.
	test("completed event still requires a valid signature before any write", async () => {
		const t = makeDb([]);
		const verifySignature = vi.fn(() => false);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			recordingDeps(t, verifySignature),
		);
		expect(res.status).toBe(403);
		expect(verifySignature).toHaveBeenCalledTimes(1);
		expect(t.convInsert).not.toHaveBeenCalled();
		expect(t.jobInsert).not.toHaveBeenCalled();
	});

	test("malformed completed event (missing CallSid) is a 200 no-op", async () => {
		const t = makeDb([]);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", {
				RecordingSid: "RE1",
				RecordingStatus: "completed",
			}),
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(200);
		expect(t.transaction).not.toHaveBeenCalled();
	});

	test("completed event creates exactly one conversation + one job", async () => {
		const t = makeDb([false]);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain");
		expect(t.convInsert).toHaveBeenCalledTimes(1);
		expect(t.jobInsert).toHaveBeenCalledTimes(1);
		expect(t.convInsert).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "me",
				callSid: "CA123",
				recordingSid: "RE123",
				durationMs: 42000,
			}),
		);
		expect(t.jobInsert).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "me", status: "pending" }),
		);
	});

	test("idempotent: a replayed completed event creates NO second job", async () => {
		// First delivery: new conversation (job inserted). Second: conflict (no job).
		const t = makeDb([false, true]);
		const deps = recordingDeps(t, () => true);
		const first = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			deps,
		);
		const second = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			deps,
		);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		// Two deliveries → two conversation INSERT attempts, but the second
		// conflicts (DO NOTHING) → exactly ONE job ever enqueued.
		expect(t.convInsert).toHaveBeenCalledTimes(2);
		expect(t.jobInsert).toHaveBeenCalledTimes(1);
	});
});

describe("handleChallenge", () => {
	function challengeRequest(query: string): Request {
		return new Request(`${ORIGIN}/api/telephony/events${query}`);
	}

	// Criterion 3.5. The value is echoed BYTE-FOR-BYTE — the provider compares for
	// exact equality and, on a mismatch, merely refuses to save the URL in its
	// panel. Nothing reaches our logs, so a trimmed / newline-suffixed / re-wrapped
	// echo is invisible from this side; only an assertion this literal catches it.
	test("echoes the provider's answer verbatim as text/plain", async () => {
		const res = handleChallenge(challengeRequest("?zd_echo=abc123"), {
			telephony: {
				handleChallenge: (url) => {
					const echo = url.searchParams.get("zd_echo");
					return echo === null
						? null
						: { body: echo, contentType: "text/plain" };
				},
			},
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain");
		// `toBe`, not `toContain`/`trim()` — a wrapper or stray byte must fail here.
		expect(await res.text()).toBe("abc123");
	});

	// The endpoint reflects caller-controlled content and is unauthenticated by
	// construction, so a browser must not be allowed to sniff the declared type
	// into markup. Cheap, and the only defense at this layer.
	test("declares nosniff on the reflected response", () => {
		const res = handleChallenge(challengeRequest("?zd_echo=x"), {
			telephony: {
				handleChallenge: () => ({ body: "x", contentType: "text/plain" }),
			},
		});
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	// F5 (impl-review phase 3). The provider owns the bytes but NOT the media type:
	// a provider declaring `text/html` would convert a reflection of
	// caller-controlled content into XSS on the app's own origin, where `nosniff`
	// is no help — it stops a browser guessing html, not a server declaring it.
	test.each([
		"text/html",
		"image/svg+xml",
		"application/xhtml+xml",
	])("clamps a %s declaration down to text/plain", async (contentType) => {
		const res = handleChallenge(challengeRequest("?zd_echo=%3Cb%3Ehi"), {
			telephony: {
				handleChallenge: () => ({ body: "<b>hi", contentType }),
			},
		});
		expect(res.headers.get("content-type")).toBe("text/plain");
		// The BODY still passes through untouched — only the type is clamped.
		expect(await res.text()).toBe("<b>hi");
	});

	// The clamp must not mangle a legitimate parameterised text/plain.
	test("preserves text/plain with parameters", () => {
		const res = handleChallenge(challengeRequest("?zd_echo=x"), {
			telephony: {
				handleChallenge: () => ({
					body: "x",
					contentType: "text/plain; charset=utf-8",
				}),
			},
		});
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	});

	// Criterion 3.6, first half: the provider answers `null` because its challenge
	// parameter is absent (a stray GET, a health checker, a scanner).
	test("404 when the provider does not recognise the request", async () => {
		const res = handleChallenge(challengeRequest(""), {
			telephony: { handleChallenge: () => null },
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toBe("text/plain");
	});

	// Criterion 3.6, second half: the provider has no handshake AT ALL (mock,
	// twilio). Absence of the optional method is meaningful — same idiom as
	// `buildInboundResponse` on the voice path — and must not throw.
	test("404 for a provider without a handshake at all", () => {
		const res = handleChallenge(challengeRequest("?zd_echo=abc123"), {
			telephony: {},
		});
		expect(res.status).toBe(404);
	});

	// Named for what it can actually observe (impl-review phase 3, F10): the URL
	// reaches the provider unchanged. The "no side effect" half of the contract is
	// NOT enforced here and cannot be — what enforces it is `ChallengeDeps` being a
	// one-key `Pick`, so a handler reaching for a `db` does not compile. If a
	// future edit hands this handler more deps, this test is where the extra
	// argument shows up.
	test("passes the request URL through", () => {
		// Typed parameter, not `vi.fn(() => null)` — an untyped spy infers an empty
		// tuple for `calls`, so the URL assertions below would be unreachable.
		const spy = vi.fn((_url: URL) => null);
		handleChallenge(challengeRequest("?zd_echo=abc&other=1"), {
			telephony: { handleChallenge: spy },
		});
		expect(spy).toHaveBeenCalledTimes(1);
		const url = spy.mock.calls[0]?.[0];
		expect(url?.pathname).toBe("/api/telephony/events");
		expect(url?.searchParams.get("zd_echo")).toBe("abc");
	});
});

/**
 * FU-4 — bounded webhook body.
 *
 * Both entrypoints are unauthenticated by design (the signature IS the auth) and
 * used to open with a bare `await request.text()`. With no body limit in App
 * Router Route Handlers, none at Fly's proxy, `NODE_OPTIONS=--max-old-space-size=256`
 * in `fly.toml` and no rate limiting on these paths, one anonymous POST could
 * materialize a few hundred MB as a single JS string and abort the process —
 * fatally, not catchably.
 *
 * The tests that matter here are the ones covering the CHUNKED case: a streamed
 * request carries no `Content-Length` at all, so a header-only guard (which is
 * what the FU-4 note prescribed) is bypassed by omitting the header. If those
 * pass while the header tests also pass, the cap is real rather than advisory.
 */
describe("bounded webhook body (FU-4)", () => {
	/** A request whose body streams `chunkCount` chunks of `chunkSize` bytes and
	 *  declares NO content-length — the shape a chunked upload actually takes. */
	function streamingRequest(
		path: string,
		chunkCount: number,
		chunkSize: number,
		opts: { failAfter?: number } = {},
	): Request {
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (opts.failAfter !== undefined && sent === opts.failAfter) {
					controller.error(new Error("connection reset mid-body"));
					return;
				}
				if (sent >= chunkCount) {
					controller.close();
					return;
				}
				sent += 1;
				controller.enqueue(new Uint8Array(chunkSize).fill(0x61)); // "a"
			},
		});
		return new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				[SIG_HEADER]: "sig",
			},
			body: stream,
			// @ts-expect-error — `duplex` is required by undici for a stream body
			// but is absent from the DOM lib's RequestInit typing.
			duplex: "half",
		});
	}

	test("a streamed body with NO content-length is still capped (the bypass)", async () => {
		const t = makeDb([false]);
		const verify = vi.fn(() => true);
		// 4 MB across 64 chunks — no content-length header exists on this request.
		const req = streamingRequest(
			"/api/telephony/recording-status",
			64,
			64 * 1024,
		);
		expect(req.headers.get("content-length")).toBeNull();

		const res = await handleRecordingStatus(req, recordingDeps(t, verify));
		expect(res.status).toBe(413);
		expect(t.db.transaction).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
	});

	test("the same bypass is closed on the voice path", async () => {
		const buildInboundResponse = vi.fn();
		const verifySignature = vi.fn(() => true);
		const res = await handleVoiceWebhook(
			streamingRequest("/api/telephony/voice", 64, 64 * 1024),
			{
				telephony: {
					signatureHeader: SIG_HEADER,
					verifySignature,
					buildInboundResponse,
				},
				publicBaseUrl: ORIGIN,
			},
		);
		expect(res.status).toBe(413);
		expect(verifySignature).not.toHaveBeenCalled();
		expect(buildInboundResponse).not.toHaveBeenCalled();
	});

	test("an oversized content-length is refused even when the body is tiny", async () => {
		const t = makeDb([false]);
		// The declared length is the ONLY oversized thing here — the actual body is
		// a valid, completed, few-byte event that would otherwise reach the DB.
		// A 413 therefore proves layer 1 fired on its own, which a stream-pull spy
		// cannot show: a ReadableStream pre-pulls one chunk at construction
		// (highWaterMark 1), so "was pull called" measures the fixture, not the
		// handler.
		const req = new Request(`${ORIGIN}/api/telephony/recording-status`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				[SIG_HEADER]: "sig",
				"content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
			},
			body: new URLSearchParams(COMPLETED).toString(),
		});

		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(413);
		expect(t.db.transaction).not.toHaveBeenCalled();
	});

	test("an UNDERSTATED content-length does not buy a large body through", async () => {
		const t = makeDb([false]);
		// A lying client: declares 10 bytes, streams 4 MB. If the header were
		// trusted as the bound, layer 1 would wave this through and `.text()`
		// would materialize the whole thing. Layer 2 is what stops it.
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 64) {
					controller.close();
					return;
				}
				sent += 1;
				controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
			},
		});
		const req = new Request(`${ORIGIN}/api/telephony/recording-status`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				[SIG_HEADER]: "sig",
				"content-length": "10",
			},
			body: stream,
			// @ts-expect-error — see note in streamingRequest.
			duplex: "half",
		});

		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(413);
		// Bounded: reading stopped shortly past the cap instead of draining 4 MB.
		expect(sent).toBeLessThanOrEqual(2);
		expect(t.db.transaction).not.toHaveBeenCalled();
	});

	test("a malformed content-length is ignored, not trusted", async () => {
		const t = makeDb([false]);
		// `Number.parseInt("banana")` is NaN and `NaN > max` is false, so the
		// request falls through to layer 2 rather than being rejected on a header
		// we cannot read — or, worse, accepted on one.
		const req = new Request(`${ORIGIN}/api/telephony/recording-status`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				[SIG_HEADER]: "sig",
				"content-length": "banana",
			},
			body: new URLSearchParams(COMPLETED).toString(),
		});
		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(200);
		expect(t.db.transaction).toHaveBeenCalledTimes(1);
	});

	test("a body exactly at the cap is accepted", async () => {
		const t = makeDb([false]);
		// One chunk of exactly MAX bytes — the boundary must be inclusive, or a
		// legitimate-but-large provider payload would be rejected.
		const req = streamingRequest(
			"/api/telephony/recording-status",
			1,
			MAX_WEBHOOK_BODY_BYTES,
		);
		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		// Not a size rejection. The padding parses to a non-`completed` event, so
		// the handler takes its ordinary no-op branch.
		expect(res.status).toBe(200);
	});

	test("one byte over the cap is refused", async () => {
		const t = makeDb([false]);
		const req = streamingRequest(
			"/api/telephony/recording-status",
			1,
			MAX_WEBHOOK_BODY_BYTES + 1,
		);
		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(413);
	});

	test("a body that errors mid-stream is a 400, not an unhandled 500", async () => {
		const t = makeDb([false]);
		const req = streamingRequest("/api/telephony/recording-status", 8, 16, {
			failAfter: 2,
		});
		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(400);
		expect(t.db.transaction).not.toHaveBeenCalled();
	});

	test("an ordinary small webhook still works end to end", async () => {
		const t = makeDb([false]);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(200);
		expect(t.db.transaction).toHaveBeenCalledTimes(1);
	});

	test("a bodyless POST reads as empty rather than throwing", async () => {
		const t = makeDb([false]);
		const req = new Request(`${ORIGIN}/api/telephony/recording-status`, {
			method: "POST",
			headers: { [SIG_HEADER]: "sig" },
		});
		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		// No params → not a completed event → the ordinary no-op branch.
		expect(res.status).toBe(200);
		expect(t.db.transaction).not.toHaveBeenCalled();
	});
});

/**
 * Ingress observability wiring (`telephony-provider-zadarma`, phase 4).
 *
 * `ingress-log.test.ts` proves the LOGGER is safe in isolation — sanitized,
 * budgeted, content-free. These tests prove the HANDLERS are actually wired to
 * it, which is a separate claim and the one that matters operationally: after
 * the Zadarma cutover the recording-status ingress went silent, and the silence
 * was indistinguishable between "the provider sends nothing" and "the provider
 * sends its seven non-actionable event types and never the recording one".
 * Every exit therefore has to speak, ESPECIALLY the no-op branch that used to
 * be the quietest.
 */
describe("ingress observability", () => {
	let lines: Record<string, unknown>[];
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		lines = [];
		_resetIngressLogStateForTests();
		spy = vi.spyOn(console, "error").mockImplementation((raw: unknown) => {
			try {
				lines.push(JSON.parse(String(raw)) as Record<string, unknown>);
			} catch {
				// `logJobEvent` also writes here; anything unparseable is not ours.
			}
		});
	});

	afterEach(() => {
		spy.mockRestore();
		_resetIngressLogStateForTests();
	});

	const ingress = (): Record<string, unknown>[] =>
		lines.filter((l) => String(l.event).startsWith("telephony.ingress."));

	// THE LINE THE WHOLE CHANGE EXISTS FOR. This branch answers 200 and writes
	// nothing to the database, so before this it left no trace anywhere.
	// F6 (impl-review): `path` must come from the URL Next.js routed, NOT a
	// literal — `/api/telephony/events` re-exports this same POST, so a literal
	// made both ingresses indistinguishable in the log and defeated the one
	// question the module exists to answer.
	test("reports which ingress URL was actually hit", async () => {
		const t = makeDb([]);
		const params = {
			CallStatus: "notify_start",
			RecordingStatus: "notify_start",
		};
		await handleRecordingStatus(
			makeRequest("/api/telephony/events", params),
			recordingDeps(t, () => true),
		);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", params),
			recordingDeps(t, () => true),
		);
		expect(ingress().map((l) => l.path)).toEqual([
			"events",
			"recording-status",
		]);
	});

	test("a non-actionable event names itself instead of vanishing", async () => {
		const t = makeDb([]);
		const res = await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", {
				CallSid: "CA1",
				RecordingSid: "RE1",
				RecordingStatus: "notify_start",
			}),
			recordingDeps(t, () => true),
		);

		expect(res.status).toBe(200);
		expect(t.transaction).not.toHaveBeenCalled();
		expect(ingress()).toHaveLength(1);
		expect(ingress()[0]).toMatchObject({
			event: "telephony.ingress.webhook",
			path: "recording-status",
			kind: "notify_start",
			outcome: "ignored",
			signed: true,
		});
	});

	test("a refused signature is reported as such, not as silence", async () => {
		const t = makeDb([]);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			recordingDeps(t, () => false),
		);
		expect(ingress()[0]).toMatchObject({
			kind: "completed",
			outcome: "forbidden",
		});
	});

	// `enqueued` vs `duplicate` is the distinction that tells a first delivery
	// from a replay absorbed by `conv_user_callsid_uq` — which, for a provider
	// that signs no URL, timestamp or nonce, is a security control rather than an
	// optimization. Its hits should be visible.
	test("accepted and replayed events are distinguishable", async () => {
		const t = makeDb([false, true]);
		const deps = recordingDeps(t, () => true);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			deps,
		);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED),
			deps,
		);
		expect(ingress().map((l) => l.outcome)).toEqual(["enqueued", "duplicate"]);
	});

	test("a missing signature header is reported as unsigned", async () => {
		const t = makeDb([]);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", COMPLETED, null),
			recordingDeps(t, () => false),
		);
		expect(ingress()[0]).toMatchObject({ signed: false });
	});

	// The body carries call identifiers and, on some providers, phone numbers.
	// None of that is logged anywhere in this project, and an ingress line is not
	// the place to start: it reports a byte COUNT.
	test("logs the body's size, never its contents", async () => {
		const t = makeDb([]);
		await handleRecordingStatus(
			makeRequest("/api/telephony/recording-status", {
				CallSid: "CA-secret-identifier",
				RecordingSid: "RE-secret-identifier",
				RecordingStatus: "notify_start",
				From: "+48123456789",
			}),
			recordingDeps(t, () => true),
		);
		const serialized = JSON.stringify(ingress()[0]);
		expect(serialized).not.toContain("secret-identifier");
		expect(serialized).not.toContain("48123456789");
		expect(ingress()[0]?.bodyBytes).toBeGreaterThan(0);
	});

	test("an over-sized body is reported before it is parsed", async () => {
		const req = new Request(`${ORIGIN}/api/telephony/recording-status`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
			},
			body: "x",
		});
		const t = makeDb([]);
		const res = await handleRecordingStatus(
			req,
			recordingDeps(t, () => true),
		);
		expect(res.status).toBe(413);
		expect(ingress()[0]).toMatchObject({
			outcome: "too-large",
			// Nothing was parsed, so there is no event name to report — and
			// `(empty)` says that honestly rather than inventing one.
			kind: "(empty)",
		});
	});

	// The handshake is how the provider verifies US, before it has signed
	// anything — so a 404 here is the symptom of "the notification URL will not
	// save", which otherwise leaves no trace on our side at all.
	test("the handshake reports whether it matched, and never the challenge", () => {
		const CHALLENGE = "zd-challenge-value";
		handleChallenge(
			new Request(`${ORIGIN}/api/telephony/events?zd_echo=${CHALLENGE}`),
			{
				telephony: {
					handleChallenge: (url) => {
						const echo = url.searchParams.get("zd_echo");
						return echo ? { body: echo, contentType: "text/plain" } : null;
					},
				},
			},
		);
		handleChallenge(new Request(`${ORIGIN}/api/telephony/events`), {
			telephony: {},
		});

		expect(ingress()).toHaveLength(2);
		expect(ingress()[0]).toMatchObject({ matched: true });
		expect(ingress()[1]).toMatchObject({ matched: false });
		expect(JSON.stringify(ingress())).not.toContain(CHALLENGE);
	});
});
