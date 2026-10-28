/**
 * Telephony provider abstraction (day-1, mirrors `stt/` + `llm/`).
 *
 * The one generic capture-primitive set the rest of MemoCall talks to. This file
 * is the CONTRACT: it must not name a vendor, nor carry a vendor's form-field
 * names or response shapes. That much holds today — the field mapping lives in
 * the sibling implementation files, and `.dependency-cruiser.cjs`
 * (`telephony-provider-abstraction`) makes reaching past this boundary from a
 * consumer an error.
 *
 * ONE vendor-shaped residue is KNOWN and deliberately deferred, not an
 * oversight — do not read this header as "the abstraction is finished":
 *   1. `callSid` / `recordingSid` carry one vendor's "SID" nomenclature. They
 *      are opaque tokens handed straight back to the provider, so the name is
 *      cosmetic — but it is still a name.
 *
 * The two literal constants that used to live OUTSIDE this directory — the
 * webhook signature header (`webhooks.ts`) and the recording MIME type
 * (`jobs/worker.ts`) — are now the `signatureHeader` / `recordingContentType`
 * properties below. An import rule cannot see a string literal, so a green
 * `depcruise` never covered them and still does not: what pins them is the
 * `Pick<>` on each consumer's deps, which makes a re-hardcoded literal a
 * compile error at the stub, plus the greps in the phase's success criteria.
 *
 * Consequently a provider swap is a new implementation file plus an env flip
 * PLUS residue 1 above. The public webhook route no longer carries a vendor's
 * name — it is `/api/telephony/*` since `telephony-provider-zadarma` phase 3,
 * moved together with the `proxy.ts` matcher token that keeps it outside the
 * session gate. Failures are reported via the shared `ProviderError` (same
 * `code` discriminator as STT/LLM).
 */

/** Inputs to webhook signature verification. */
export type WebhookSignatureInput = {
	/** The signature value carried by the provider's webhook header. */
	signature: string;
	/**
	 * The FULL external URL the provider signed against — populated ONLY for
	 * providers whose signature covers the URL. Behind Fly's proxy the internal
	 * request URL won't match, so the caller reconstructs this from
	 * `PUBLIC_BASE_URL` + the path — never from the incoming request host.
	 *
	 * Optional because not every provider signs the URL (some sign only the
	 * concatenated body fields). A provider that DOES require it must REFUSE
	 * when it is absent — fail-closed, never "assume valid".
	 */
	url?: string;
	/** The parsed form-encoded POST params (verbatim keys/values). */
	params: Record<string, string>;
};

/**
 * Vendor-neutral shape of a recording-status callback. Each provider's
 * `parseRecordingEvent` maps its own form fields onto this; consuming code never
 * sees a raw vendor key.
 */
export type RecordingEvent = {
	callSid: string;
	recordingSid: string;
	/** Lowercased lifecycle status, e.g. `completed`. */
	recordingStatus: string;
	/** Caller leg / called leg phone numbers when present. */
	from?: string;
	to?: string;
	recordingDurationMs?: number;
	startedAt?: Date;
	endedAt?: Date;
};

/**
 * A recording still resident at the provider — i.e. one MemoCall has NOT yet
 * turned into a note. Used by capture reconciliation, which asks the provider
 * "what is still lying at your end?" and backfills whatever has no row here.
 *
 * The set is meaningful only because of FR-002: a recording is deleted at the
 * provider ONLY after its job completes, so "still resident" is an exact,
 * free-of-charge ledger of the capture debt. Nothing else has to be modelled.
 *
 * ⚠️ THE MISSING FIELDS ARE THE POINT — do not "harmonize" this with
 * `RecordingEvent` by adding `from` / `to` or any other slot a phone number
 * could occupy. The provider responses this is mapped from DO carry the other
 * party's number, and the rule at `dialed_numbers` in `schema.ts` is that a
 * number arriving from the PROVIDER — exactly the number this type is mapped
 * from — has ONE legitimate home since FR-025: `conversations.counterparty_e164`,
 * written only by the counterparty sweep (`jobs/counterparty.ts`) through its
 * own `CounterpartyResolution` shape, never through this one
 * (`counterparty-write-path.test.ts` pins it). Reconciliation is not that
 * path, and therefore holds numbers in process memory and nowhere else — never in the
 * database, never in a log line. What ENFORCES that is the absence of a field
 * on this type: a consumer reaching for the number gets a compile error, not a
 * code-review comment. Adding one here re-opens the product decision recorded
 * in `context/foundation/roadmap-post-mvp.md` (S-06).
 *
 * The timing fields are optional and a provider may legitimately leave all
 * three unset (Zadarma does — see `zadarma-statistics.ts`), which lands exactly
 * the same nullable columns the webhook path already leaves NULL for it.
 *
 * ⚠️ AS OF TODAY NO PROVIDER FILLS THEM — they are write-never, not a contract
 * someone forgot. Said plainly so the next reader does not "finish" them by
 * parsing a vendor timestamp: the only vendor that could is Zadarma, whose
 * `callstart` is in ACCOUNT time, and interpreting it would be a second,
 * independent clock shift whose failure mode is a `started_at` silently two
 * hours off. They stay for the provider that reports UTC instants directly.
 *
 * FR-025 (2026-10-19) did NOT add a number here, although `conversations` now
 * carries one: the counterparty travels by its OWN path, `CounterpartyResolution`
 * below, read by `resolveCounterparties` and written by `jobs/counterparty.ts`
 * through an `UPDATE` of a row that already exists. The INSERT path this type
 * feeds stays number-free, which is what keeps "a new conversation" and "its
 * other party" two separate writes with two separate guards.
 */
export type PendingRecording = {
	/** The provider's call identifier — becomes `conversations.call_sid`. */
	callSid: string;
	/** The token that fetches the audio — becomes `conversations.recording_sid`. */
	recordingSid: string;
	startedAt?: Date;
	endedAt?: Date;
	durationMs?: number;
};

/**
 * Who a recorded call was with, as the PROVIDER reports it (FR-025). The one
 * vendor-neutral shape a phone number is allowed to cross this boundary in,
 * and it crosses in exactly one direction: provider → `jobs/counterparty.ts`
 * → `UPDATE conversations … WHERE counterparty_state = 'pending'`. Nothing
 * else may consume it, and the resolver is the only module that may bind
 * `rawNumber` to a statement.
 *
 * `rawNumber` is `+`-or-nothing plus 7–15 digits, validated for SHAPE only;
 * canonical form (Polish → `normalizePolishE164`, else `+` + digits) is the
 * resolver's job, not the provider's, so the join to `contacts.e164` is decided
 * in one place. `nameHint` is the presentation name the provider attached
 * (`"Name" <number>`), trimmed and capped by the provider, absent when blank or
 * when it merely restates the number. It is a HINT shown until the user labels
 * the number — never authoritative, and bound by the same no-prompt / no-log /
 * deleted-with-the-conversation rules as the number.
 *
 * `withheld` means the provider's row was present but carried NO number at
 * all — empty, absent, or a word without a single digit (CLIR, "Anonymous").
 * `unparsed` means the field carried SOMETHING number-like (digits, or a value
 * of an unexpected type) that the provider could not read as a phone number:
 * that is format drift, not withholding, so the resolver writes nothing,
 * leaves the conversation `pending` and counts it — a terminal `withheld` there
 * would turn a vendor format change into a permanent, silent "operator gave no
 * number" on every call (impl-review F2, 2026-10-20). A call with NO row in the
 * window has NO entry in the result — not a `withheld` one — so the resolver
 * can leave it `pending` for a later sweep. Deliberately no timing fields: this type answers "who",
 * and `PendingRecording` already explains why "when" is left to NULL.
 */
export type CounterpartyResolution =
	| {
			callSid: string;
			outcome: "known";
			rawNumber: string;
			nameHint?: string;
			/**
			 * Which way the call went, when the provider knows. Used ONLY to tell
			 * the user's own number on an OUTBOUND leg (the leg rule is wrong —
			 * an alarm) from a call the user placed FROM their own GSM to their
			 * own DID (legitimate, e.g. a voice memo). Absent = unknown, treated
			 * as outbound, i.e. as the alarm (full-plan impl-review F5).
			 */
			direction?: "inbound" | "outbound";
	  }
	| { callSid: string; outcome: "withheld" }
	| { callSid: string; outcome: "unparsed" };

export interface TelephonyProvider {
	/**
	 * Name of the HTTP header carrying this provider's webhook signature.
	 *
	 * MUST be a syntactically valid HTTP header token. This is the constraint
	 * with teeth: the handlers pass it straight to `Request.headers.get`, which
	 * THROWS `TypeError` on an empty or malformed name (measured, not assumed).
	 * The throw lands before `verifySignature`, so it stays fail-closed — but the
	 * endpoint then answers 500 instead of 403, which is far harder to spot in
	 * the logs. A name the request simply does not CARRY is fine and expected:
	 * `get` returns null, the handler substitutes `""`, and verification refuses.
	 *
	 * Lowercase by convention, NOT for correctness — `headers.get` is
	 * case-insensitive, so a capitalized value matches too; lowercase just keeps
	 * providers' declarations directly comparable. The concrete name lives in
	 * each implementation file; naming one here would put a vendor back into the
	 * contract.
	 *
	 * A constant field, not a getter: it is read once per webhook request, and a
	 * getter that computed anything (or touched `env`) would add cost where the
	 * hardcoded literal had none.
	 */
	readonly signatureHeader: string;

	/**
	 * MIME type of the byte stream `streamRecording` produces — the recording
	 * media as THIS provider serves it, not a general preference. The job layer
	 * forwards it to the STT provider as the request content type, so a value
	 * that disagrees with the actual bytes silently mis-declares the upload.
	 */
	readonly recordingContentType: string;

	/**
	 * Verify an inbound webhook is genuinely from the provider. Pure + sync —
	 * a keyed MAC over whatever that provider signs (see `WebhookSignatureInput`).
	 * Returns `false` on anything it cannot verify; never throws, never
	 * fail-open — this is the ONLY authorization a webhook has.
	 */
	verifySignature(input: WebhookSignatureInput): boolean;

	/**
	 * Build the response to the inbound voice webhook: instruct the provider to
	 * dial the user's GSM and record dual-channel, pointing the recording
	 * callback at `recordingStatusCallbackUrl`. The forward number is provider
	 * config (env), not a per-call arg.
	 *
	 * Returns body + content type as a pair so the handler never has to guess
	 * the media type of a format it does not parse.
	 *
	 * OPTIONAL, and its ABSENCE IS MEANINGFUL: a provider that does not
	 * implement it has no inbound voice webhook at all, because its call
	 * scenario lives on the provider's side (configured in their panel) rather
	 * than being generated per-request by us. The handler answers 404 for such a
	 * provider — for it, that endpoint genuinely does not exist.
	 */
	buildInboundResponse?(input: { recordingStatusCallbackUrl: string }): {
		body: string;
		contentType: string;
	};

	/**
	 * Answer the provider's URL-verification handshake, if it has one.
	 *
	 * Some providers refuse to SAVE a notification URL until it proves it is ours
	 * by echoing a challenge value they put in the query string of a plain GET.
	 * `url` is the incoming request URL; the provider reads whatever query
	 * parameter it owns out of it.
	 *
	 * The returned `body` is sent back **byte-for-byte** — no trimming, no
	 * appended newline, no BOM, no wrapping. A provider may compare the response
	 * for exact equality, and when it does not match the only symptom is "the URL
	 * cannot be saved in their panel": nothing reaches our logs, so a mangled echo
	 * is invisible from this side. `contentType` comes from the provider for the
	 * same reason `buildInboundResponse` returns one — the handler must not guess
	 * the media type of a format it does not parse.
	 *
	 * Returns `null` when the request is NOT this provider's handshake (its
	 * challenge parameter is absent), which the handler answers as 404.
	 *
	 * OPTIONAL, and its ABSENCE IS MEANINGFUL — same idiom as
	 * `buildInboundResponse` above: a provider that does not implement it runs no
	 * handshake at all, and the handler answers 404 because for that provider the
	 * endpoint genuinely does not exist.
	 *
	 * Pure + sync, and MUST have no side effect: the endpoint reflecting this
	 * value is unauthenticated by construction (the handshake is how the provider
	 * verifies US — it has nothing to sign with yet).
	 */
	handleChallenge?(url: URL): { body: string; contentType: string } | null;

	/** Map raw callback form params onto the vendor-neutral `RecordingEvent`. */
	parseRecordingEvent(params: Record<string, string>): RecordingEvent;

	/**
	 * Place an OUTBOUND click-to-call. Rings the configured user GSM first
	 * (provider config, not a per-call arg), then bridges to `to` on answer and
	 * records dual-channel, pointing the recording callback at
	 * `recordingStatusCallbackUrl`. `to` is the already-normalized E.164 recipient
	 * (normalization is the mutation's job, not the provider's). The outbound
	 * caller-id DID is provider config (env), not a per-call arg. The placed call
	 * fires the SAME `recording-status` callback as an inbound one, so the entire
	 * worker→STT→LLM→panel path is reused with zero changes. Throws `ProviderError`
	 * on failure.
	 */
	placeCall(input: {
		to: string;
		recordingStatusCallbackUrl: string;
	}): Promise<{ callSid: string }>;

	/**
	 * Stream the authenticated recording bytes into the caller-provided sink.
	 * MUST NOT buffer the whole recording on the heap (256 MB Fly Machine) —
	 * pipe the response body straight through. An optional `signal` is forwarded
	 * to the internal `pipeTo` so the caller can tear the pull down: the worker's
	 * telephony→STT bridge aborts it once transcription settles, so a provider that
	 * errors before draining the body can't leave the pull stalled on backpressure
	 * (worker F1). A `pipeTo` cannot be torn down any other way — its lock on the
	 * sink + source blocks external `abort()`/`cancel()`.
	 */
	streamRecording(
		input: { recordingSid: string },
		sink: WritableStream<Uint8Array>,
		opts?: { signal?: AbortSignal },
	): Promise<void>;

	/**
	 * Delete the recording at the provider (FR-002). Idempotent: an
	 * already-deleted recording (HTTP 404) resolves as success.
	 */
	deleteRecording(input: { recordingSid: string }): Promise<void>;

	/**
	 * List the recordings still resident at the provider in `[since, until]` —
	 * the capture debt (see `PendingRecording`). Capture reconciliation calls
	 * this on a slow cadence and backfills every entry whose `callSid` has no
	 * row in `conversations`.
	 *
	 * `since` / `until` are ordinary UTC instants. A provider whose API speaks
	 * some other clock (Zadarma bills its statistics window in ACCOUNT time)
	 * converts on its own side — that is an implementation detail and must not
	 * leak to the caller, because a caller that had to know would be a caller
	 * that can get it wrong.
	 *
	 * MUST throw `ProviderError` on any failure. It must NEVER quietly return a
	 * partial list: a short answer is indistinguishable from "nothing is
	 * pending", which is precisely the silent state this whole feature exists to
	 * abolish.
	 *
	 * OPTIONAL, and its ABSENCE IS MEANINGFUL — the same idiom as
	 * `buildInboundResponse` and `handleChallenge` above. A provider that does
	 * not implement it simply has no reconciliation, and the sweep is a clean
	 * no-op for it rather than a failure. That is the honest state for the mock
	 * (there is no vendor to ask) and for Twilio (that account is being wound
	 * down; adding it there would be new integration work against a vendor we
	 * are leaving).
	 */
	listRecordingsAwaitingCapture?(input: {
		since: Date;
		until: Date;
		/**
		 * Optional teardown handle, mirroring `streamRecording`'s. The sweep that
		 * calls this runs inside the job poller's tick, so an unbounded request
		 * would let stalled calls accumulate across ticks. A provider MUST bound
		 * the request itself when none is supplied — this parameter exists so a
		 * caller CAN cancel sooner, never so it must.
		 */
		signal?: AbortSignal;
	}): Promise<PendingRecording[]>;

	/**
	 * Who the calls that STARTED in `[since, until]` were with, one entry per
	 * call the provider has a row for (see `CounterpartyResolution`, FR-025).
	 * The counterparty sweep (`jobs/counterparty.ts`) calls this on the same
	 * slow cadence as reconciliation, right after it, and only while at least
	 * one conversation is still `pending` — a quiet instance makes no request.
	 *
	 * `since` / `until` are UTC instants; the account-clock conversion is the
	 * provider's business, exactly as for `listRecordingsAwaitingCapture`.
	 * MUST throw `ProviderError` on any failure and NEVER return a quietly
	 * partial list — the resolver cannot tell "no row for this call" from
	 * "the page was truncated before its row", and the first is a legitimate
	 * answer (leave it `pending`) while the second would leave it `pending`
	 * forever.
	 *
	 * OPTIONAL, and its ABSENCE IS MEANINGFUL — same idiom as the three
	 * optional methods above. A provider without it resolves no numbers at
	 * all: its conversations go `pending` → `unavailable` after 24 h, which is
	 * the honest state for the mock (no vendor to ask) and for Twilio (being
	 * wound down). Implemented by Zadarma only; it is a SECOND statistics
	 * request per tick rather than a second output of the first one, so that
	 * `zadarma-statistics.ts` — which is forbidden by its own source test to
	 * name the number fields — stays byte-identical.
	 */
	resolveCounterparties?(input: {
		since: Date;
		until: Date;
		/** As on `listRecordingsAwaitingCapture`: a provider MUST bound itself. */
		signal?: AbortSignal;
	}): Promise<CounterpartyResolution[]>;
}
