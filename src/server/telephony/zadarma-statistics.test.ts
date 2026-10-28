import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	mapZadarmaPendingRecordings,
	scanZadarmaStatistics,
} from "~/server/telephony/zadarma-statistics";

/**
 * Unit tests for the `/v1/statistics/pbx/?version=2` response mapping — the one
 * module that knows that response's shape, and the one place a phone number
 * could escape capture reconciliation.
 *
 * PROVENANCE OF THE FIXTURES, stated because `lessons.md` requires it of any
 * frozen literal. These are NOT golden vectors and prove nothing about the
 * vendor: they are hand-built rows in the SHAPE measured live on 2026-09-08
 * (recorded in this change's `frame.md`) — `pbx_call_id` as `in_`/`out_` + 40
 * hex, `call_id` as `<digits>.<digits>`, one conversation spanning a trunk leg
 * (`sip: "0"`) and an extension leg (`sip: "100"`) under one `pbx_call_id`, with
 * only the extension leg reporting resident audio. What the live API actually
 * returns is settled by the phase's manual probe, not by this file. The phone
 * numbers are PLACEHOLDERS, never the operator's or anyone's real number —
 * this file lands in git history and in every PR diff shipped to the CI
 * reviewer (same rule as `zadarma.test.ts`).
 */

const INBOUND_ID = "in_20b67427cf29e305a77f09d12a3976e092787adf";
const OUTBOUND_ID = "out_d0b9c44cd60506e90d85f31ea088089d9c3ef0cc";

/** A statistics row carrying every field the live shape does, numbers included. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		pbx_call_id: INBOUND_ID,
		call_id: "1788883091.244520",
		is_recorded: true,
		sip: "100",
		disposition: "answered",
		callstart: "2026-09-08 15:59:47",
		seconds: 664,
		// The two fields the mapper must never carry across.
		clid: "+48500100200",
		destination: "+48500100300",
		...overrides,
	};
}

function envelope(stats: unknown): Record<string, unknown> {
	return { status: "success", stats };
}

describe("mapZadarmaPendingRecordings — envelope shape", () => {
	// `[]` and `null` are DIFFERENT answers and the caller depends on it: `[]` is
	// "the window held no resident recordings", `null` becomes an
	// `invalid_response` ProviderError. Collapsing them turns an envelope change
	// into a permanently empty debt ledger — the silent blindness the whole
	// feature exists to remove.
	it("returns null for anything that is not an object", () => {
		expect(mapZadarmaPendingRecordings(null)).toBeNull();
		expect(mapZadarmaPendingRecordings("stats")).toBeNull();
		expect(mapZadarmaPendingRecordings(undefined)).toBeNull();
	});

	it("returns null when `stats` is present but not an array", () => {
		expect(mapZadarmaPendingRecordings(envelope({ 0: row() }))).toBeNull();
		expect(mapZadarmaPendingRecordings(envelope("none"))).toBeNull();
	});

	// Judgement call, documented on the function: the vendor's behaviour on an
	// empty window is not pinned, and failing the sweep every five minutes on a
	// quiet account would be worse than this blind spot.
	it("treats an absent `stats` key as an empty window, not as a shape change", () => {
		expect(mapZadarmaPendingRecordings({ status: "success" })).toEqual([]);
		expect(mapZadarmaPendingRecordings(envelope([]))).toEqual([]);
	});

	it("skips non-object entries instead of failing the whole window", () => {
		expect(mapZadarmaPendingRecordings(envelope([null, "x", row()]))).toEqual([
			{ callSid: INBOUND_ID, recordingSid: "1788883091.244520" },
		]);
	});
});

describe("mapZadarmaPendingRecordings — the `is_recorded` filter [1.5]", () => {
	// The field arrives as a JSON boolean on some rows and as a string on others.
	// `Boolean("false")` is `true`, so a truthiness test would report every
	// already-deleted recording as outstanding debt and re-backfill forever.
	it("accepts the resident values in both representations", () => {
		for (const value of [true, "true", "True", " true ", "1", 1]) {
			expect(
				mapZadarmaPendingRecordings(envelope([row({ is_recorded: value })])),
			).toHaveLength(1);
		}
	});

	// RECOGNIZED-false: the vendor said "the audio is gone". Empty set, no error.
	it("rejects every recognized non-resident value, string 'false' included", () => {
		for (const value of [false, "false", "False", "0", 0, ""]) {
			expect(
				mapZadarmaPendingRecordings(envelope([row({ is_recorded: value })])),
			).toEqual([]);
		}
	});

	// UNRECOGNIZED is a different answer and must not collapse into the one above
	// — `null`/`undefined` mean the field did not speak, not that it said "no".
	it("does not read a null/undefined `is_recorded` as a recognized 'no'", () => {
		for (const value of [null, undefined]) {
			expect(
				mapZadarmaPendingRecordings(envelope([row({ is_recorded: value })])),
			).toBeNull();
		}
	});

	/**
	 * A response in which NOT ONE row spoke a representation we recognize is a
	 * vendor whose field changed shape — not a quiet window. It returns `null`
	 * (→ `invalid_response` at the caller) so the sweep logs a named error,
	 * rather than `[]`, which would read as a permanently empty debt ledger with
	 * nothing wrong anywhere. One odd row among good ones stays harmless; see the
	 * next test.
	 */
	it("fails loudly when NO row carries a recognized `is_recorded`", () => {
		const bare = row();
		delete bare.is_recorded;
		expect(mapZadarmaPendingRecordings(envelope([bare]))).toBeNull();
		expect(
			mapZadarmaPendingRecordings(envelope([row({ is_recorded: "yes" })])),
		).toBeNull();
	});

	it("tolerates ONE unrecognized row alongside a recognized one", () => {
		const stats = [
			row({ is_recorded: "yes", pbx_call_id: OUTBOUND_ID }),
			row({ is_recorded: true }),
		];
		expect(mapZadarmaPendingRecordings(envelope(stats))).toEqual([
			{ callSid: INBOUND_ID, recordingSid: "1788883091.244520" },
		]);
	});
});

describe("mapZadarmaPendingRecordings — one conversation, many rows [1.5]", () => {
	// The trap this pins: filtering AFTER deduping would keep the trunk leg, call
	// a recorded conversation unrecorded, and silently lose the note.
	it("picks the resident leg out of a multi-leg conversation", () => {
		const stats = [
			row({ sip: "0", is_recorded: false, call_id: "1788883091.111111" }),
			row({ sip: "100", is_recorded: true, call_id: "1788883091.244520" }),
		];
		expect(mapZadarmaPendingRecordings(envelope(stats))).toEqual([
			{ callSid: INBOUND_ID, recordingSid: "1788883091.244520" },
		]);
	});

	/**
	 * PROVENANCE, field by field, because "live-shaped" and "live" are not the
	 * same claim and conflating them is what let the HMAC vector drift
	 * (`lessons.md`).
	 *
	 * LIVE, from conversation `in_d30d9346…` on 2026-09-08: the two `call_id`
	 * values, the two leg durations (10 s ring / 126 s talk), the `sip` split,
	 * and — the part that matters — the EXPECTED ANSWER. `1788883091.244520` is
	 * the `recording_sid` the vendor itself delivered by `NOTIFY_RECORD` for this
	 * conversation, read back out of the production database on 2026-09-09. It
	 * did not come from this code, which is what makes this a correctness test
	 * rather than a change-detector.
	 *
	 * NOT LIVE: `pbx_call_id` is this file's shaped placeholder (`INBOUND_ID`),
	 * and `is_recorded` is forced back to resident because the real audio has
	 * since been deleted. Neither affects what is being proven.
	 *
	 * Response order is deliberately the vendor's own — ring leg FIRST — because
	 * that is the order under which a first-seen tiebreak silently picks eight
	 * seconds of ringback and produces a plausible-looking empty note.
	 */
	it("picks the LONGEST leg, not the first, when several report resident audio", () => {
		const stats = [
			row({ call_id: "1788883090.244506", sip: "0", seconds: 10 }),
			row({ call_id: "1788883091.244520", sip: "100", seconds: 126 }),
		];
		const mapped = mapZadarmaPendingRecordings(envelope(stats));
		expect(mapped).toHaveLength(1);
		expect(mapped?.[0]?.recordingSid).toBe("1788883091.244520");
	});

	// BOTH orderings of the SAME pair. Asserting only [long, short] would pass
	// under the very first-seen implementation this rule replaced — the two agree
	// in that order, so a one-sided test names coverage it does not have.
	// The pair is live: conversation `in_ce8a39d5…`, 8 s ring / 69 s talk, and
	// the vendor's own NOTIFY_RECORD named the 69 s leg.
	it("picks the longest leg under BOTH response orderings", () => {
		const longLeg = row({ call_id: "1788862088.106712", seconds: 69 });
		const shortLeg = row({ call_id: "1788862087.106685", seconds: 8 });
		for (const stats of [
			[longLeg, shortLeg],
			[shortLeg, longLeg],
		]) {
			expect(
				mapZadarmaPendingRecordings(envelope(stats))?.[0]?.recordingSid,
			).toBe("1788862088.106712");
		}
	});

	it("accepts a string `seconds`, which the vendor's JSON may quote", () => {
		const stats = [
			row({ call_id: "1788883090.244506", seconds: "10" }),
			row({ call_id: "1788883091.244520", seconds: "126" }),
		];
		expect(
			mapZadarmaPendingRecordings(envelope(stats))?.[0]?.recordingSid,
		).toBe("1788883091.244520");
	});

	// A missing duration must cost the leg the comparison, never the whole
	// recording: one leg with no readable `seconds` still yields a backfill.
	it("still returns a recording when no leg has a readable duration", () => {
		const bare = row();
		bare.seconds = null;
		const mapped = mapZadarmaPendingRecordings(envelope([bare]));
		expect(mapped).toHaveLength(1);
		expect(mapped?.[0]?.callSid).toBe(INBOUND_ID);
	});

	it("prefers a leg with a readable duration over one without", () => {
		const unreadable = row({ call_id: "1788883090.244506" });
		unreadable.seconds = "nonsense";
		const stats = [
			unreadable,
			row({ call_id: "1788883091.244520", seconds: 126 }),
		];
		expect(
			mapZadarmaPendingRecordings(envelope(stats))?.[0]?.recordingSid,
		).toBe("1788883091.244520");
	});

	/**
	 * A live row this reconciler must NEVER act on: `out_b8e7e135…`, a 0-second
	 * unanswered callback attempt from 2026-09-08. It appears in the vendor's
	 * statistics and has no row in `conversations` — which is precisely the
	 * "missing" shape the sweep hunts for. `is_recorded` false is the only thing
	 * standing between it and a conversation manufactured out of a call that
	 * never happened.
	 */
	it("ignores an unanswered call that has no recording", () => {
		const noAnswer = row({
			pbx_call_id: "out_b8e7e135a7fc4130eb4a802a75c6a961d1092970",
			call_id: "1788862848.376311",
			is_recorded: false,
			disposition: "no answer",
			seconds: 0,
		});
		expect(mapZadarmaPendingRecordings(envelope([noAnswer]))).toEqual([]);
	});

	it("keeps distinct conversations apart", () => {
		const stats = [row(), row({ pbx_call_id: OUTBOUND_ID })];
		expect(
			mapZadarmaPendingRecordings(envelope(stats))?.map((r) => r.callSid),
		).toEqual([INBOUND_ID, OUTBOUND_ID]);
	});
});

describe("mapZadarmaPendingRecordings — id validation [1.5]", () => {
	// `pbx_call_id` becomes `conversations.call_sid`, the anchor of the
	// `conv_user_callsid_uq` index that is a SECURITY control under this provider.
	// The same predicate must hold whether an id arrives by webhook or is read
	// back out of statistics — which is why there is one regex, in
	// `zadarma-params.ts`, and not a copy here.
	it("drops rows whose pbx_call_id does not match the pinned shape", () => {
		for (const bad of [
			"in_short",
			"in_20b67427cf29e305a77f09d12a3976e092787ad", // 39 hex
			"in_20b67427cf29e305a77f09d12a3976e092787adff", // 41 hex
			"IN_20b67427cf29e305a77f09d12a3976e092787adf", // wrong case
			"mid_20b67427cf29e305a77f09d12a3976e092787adf",
			`${INBOUND_ID}\n${INBOUND_ID}`, // anchors must reject a newline splice
			"",
		]) {
			expect(
				mapZadarmaPendingRecordings(envelope([row({ pbx_call_id: bad })])),
			).toEqual([]);
		}
	});

	it("drops rows with no usable call_id — the only route to the audio", () => {
		for (const bad of ["", null, undefined, {}]) {
			expect(
				mapZadarmaPendingRecordings(envelope([row({ call_id: bad })])),
			).toEqual([]);
		}
		const bare = row();
		delete bare.call_id;
		expect(mapZadarmaPendingRecordings(envelope([bare]))).toEqual([]);
	});

	/**
	 * The mapper used to ACCEPT a numeric `call_id` and pass it through
	 * `String()`. That looked tolerant and silently corrupted the one token that
	 * fetches the audio: `String(JSON.parse("1788883091.244520"))` is
	 * `"1788883091.24452"`, because a double round-trips only to its shortest
	 * decimal form. That exact value is what `frame.md` measured as
	 * `recording_sid == call_id`, so the corruption would have hit a real
	 * recording — and by the time the fetch failed, the `conversations` row would
	 * already exist, making the genuine `NOTIFY_RECORD` a no-op against
	 * `conv_user_callsid_uq`. Permanent silent loss, caused by the reconciler.
	 *
	 * Measured 2026-09-09: the vendor QUOTES the field, so this was a trap rather
	 * than a live bug. Dropping the row costs one sweep; corrupting the id costs
	 * the recording.
	 */
	it("REFUSES a numeric call_id rather than round-tripping it through String()", () => {
		const asNumber = JSON.parse('{"v":1788883091.244520}').v as number;
		// The premise, asserted so this test explains itself if it ever fails.
		expect(String(asNumber)).toBe("1788883091.24452");
		expect(
			mapZadarmaPendingRecordings(envelope([row({ call_id: asNumber })])),
		).toEqual([]);
		expect(
			mapZadarmaPendingRecordings(envelope([row({ call_id: 1788883091 })])),
		).toEqual([]);
	});
});

describe("mapZadarmaPendingRecordings — privacy guard [1.6]", () => {
	/**
	 * The load-bearing test of this file. The vendor's rows carry the other
	 * party's number in `destination` and `clid`. Since FR-025 a vendor-supplied
	 * number has exactly one legitimate home — `conversations.counterparty_e164`,
	 * written only by the counterparty sweep (`jobs/counterparty.ts`, pinned by
	 * `counterparty-write-path.test.ts`). Reconciliation is not that path, and
	 * `PendingRecording` is not that shape. Reconciliation is therefore allowed to hold
	 * a number in process memory and nowhere else. Asserting on the SERIALIZED
	 * output rather than on named fields is the point: a future field added to
	 * `PendingRecording` that happened to carry a number would slip past a
	 * per-field assertion and fail here.
	 */
	it("carries no phone number of any kind onto its output", () => {
		const clid = "+48500100200";
		const destination = "+48500100300";
		const stats = [
			row({ clid, destination }),
			row({ pbx_call_id: OUTBOUND_ID, clid, destination }),
		];
		const serialized = JSON.stringify(
			mapZadarmaPendingRecordings(envelope(stats)),
		);
		expect(serialized).not.toContain(clid);
		expect(serialized).not.toContain(destination);
		// Also in the bare-digits form, in case a vendor row drops the `+`.
		expect(serialized).not.toContain("48500100200");
		expect(serialized).not.toContain("48500100300");
	});

	it("emits exactly the two contract fields and nothing else", () => {
		const mapped = mapZadarmaPendingRecordings(envelope([row()]));
		// Not `toEqual` on the object alone: this asserts no EXTRA key survived,
		// which is what stops a "harmonize it with RecordingEvent" edit landing a
		// `from`/`to` slot without anyone noticing.
		expect(Object.keys(mapped?.[0] ?? {}).sort()).toEqual([
			"callSid",
			"recordingSid",
		]);
	});

	/**
	 * The timing fields stay unset on purpose. `callstart` is expressed in
	 * ACCOUNT time (UTC+2 as measured), and the account-clock shift is applied in
	 * exactly ONE direction — when building the window parameters. Parsing it
	 * back here would be a second, independent shift whose failure mode is a
	 * `started_at` silently two hours off. Leaving them unset lands precisely the
	 * NULL columns the Zadarma webhook path already leaves.
	 */
	it("does not interpret `callstart` — no second clock shift", () => {
		const mapped = mapZadarmaPendingRecordings(envelope([row()]));
		expect(mapped?.[0]?.startedAt).toBeUndefined();
		expect(mapped?.[0]?.endedAt).toBeUndefined();
		expect(mapped?.[0]?.durationMs).toBeUndefined();
	});
});

describe("zadarma-statistics.ts source guard [1.7]", () => {
	/**
	 * The mechanical half of the privacy rule: the mapper must not so much as
	 * NAME the vendor's phone-number fields in executable code — not even to
	 * destructure and discard them, because a discarded binding is one edit away
	 * from a used one.
	 *
	 * Comments are stripped before scanning, per the recurring rule in
	 * `lessons.md` ("prose that merely mentions a path must not trip the guard").
	 * The header of the module under test names `destination` and `clid` on
	 * purpose — that warning is what stops the fields being added back, so a
	 * scanner that tripped on it would push us to delete the warning to satisfy
	 * the guard, which is exactly backwards.
	 *
	 * A source scan, not a behavioural one, because the behavioural guard above
	 * can only see fields that reach the OUTPUT. Reading a number into a local,
	 * a metric or a thrown message would pass that test and fail this one.
	 */
	it("names no phone-number field outside its comments", () => {
		const source = readFileSync(
			new URL("./zadarma-statistics.ts", import.meta.url),
			"utf8",
		);
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		// Guard against the scan passing vacuously on an empty read.
		expect(code).toContain("mapZadarmaPendingRecordings");
		expect(code).not.toMatch(/\bdestination\b/);
		expect(code).not.toMatch(/\bclid\b/);
	});

	/**
	 * The half `depcruise` structurally cannot cover, and the reason the rule's
	 * "structural, not a promise" wording is only true WITH this test.
	 * `telephony-params-are-pure` sees IMPORTS. `console`, `process` and `fetch`
	 * are GLOBALS — so a single `console.error(JSON.stringify(row))` in the
	 * mapper passes the rule cleanly and dumps `destination` and `clid` into
	 * Fly's ~7-day log window, which is the only audit trail this system has.
	 * Note it would also evade the field-name scan above, since a whole-row dump
	 * names neither field.
	 */
	it("holds no egress primitive — no console, process or fetch", () => {
		const source = readFileSync(
			new URL("./zadarma-statistics.ts", import.meta.url),
			"utf8",
		);
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		expect(code).toContain("mapZadarmaPendingRecordings");
		expect(code).not.toMatch(/\bconsole\b/);
		expect(code).not.toMatch(/\bprocess\b/);
		expect(code).not.toMatch(/\bfetch\b/);
	});
});

/**
 * Full-review F3. Until these counters existed, the three `continue`s in the
 * scan discarded rows and reported nothing, and the phase-1 F8 guard covered
 * only the case where NOT ONE row was recognized. A PARTIAL drift — some rows
 * readable, every RESIDENT one unusable — produced an empty list and no error,
 * i.e. `{scanned: 0}`, indistinguishable from a quiet account.
 *
 * These tests are what make the counters load-bearing rather than decorative:
 * each one pins a drop reason that would otherwise be invisible.
 */
describe("scanZadarmaStatistics — drop counters [full-review F3]", () => {
	const resident = (over: Record<string, unknown>) => ({
		is_recorded: "true",
		pbx_call_id: `in_${"a".repeat(40)}`,
		call_id: "1788875984.24036",
		seconds: "120",
		...over,
	});

	it("counts a resident row whose pbx_call_id fails the shape", () => {
		const scan = scanZadarmaStatistics({
			stats: [resident({ pbx_call_id: "in_NOT_HEX" })],
		});
		expect(scan).not.toBeNull();
		expect(scan?.recordings).toHaveLength(0);
		expect(scan?.rawRows).toBe(1);
		expect(scan?.droppedBadId).toBe(1);
		expect(scan?.droppedNoCallId).toBe(0);
		expect(scan?.droppedUnrecognized).toBe(0);
	});

	it("counts a resident row with no call_id to fetch audio by", () => {
		const scan = scanZadarmaStatistics({ stats: [resident({ call_id: "" })] });
		expect(scan?.recordings).toHaveLength(0);
		expect(scan?.droppedNoCallId).toBe(1);
		expect(scan?.droppedBadId).toBe(0);
	});

	it("counts an unrecognized is_recorded representation", () => {
		// Some rows readable, so the phase-1 F8 total guard does NOT fire — this is
		// exactly the partial drift that used to pass silently.
		const scan = scanZadarmaStatistics({
			stats: [
				resident({ is_recorded: "false" }),
				resident({ is_recorded: "Y" }),
			],
		});
		expect(scan).not.toBeNull();
		expect(scan?.recordings).toHaveLength(0);
		expect(scan?.rawRows).toBe(2);
		expect(scan?.droppedUnrecognized).toBe(1);
	});

	it("reports zero drops on a clean window", () => {
		const scan = scanZadarmaStatistics({ stats: [resident({})] });
		expect(scan?.recordings).toHaveLength(1);
		expect(scan?.rawRows).toBe(1);
		expect(
			(scan?.droppedUnrecognized ?? 0) +
				(scan?.droppedBadId ?? 0) +
				(scan?.droppedNoCallId ?? 0),
		).toBe(0);
	});

	it("stays a projection: the thin mapper returns exactly scan.recordings", () => {
		// Guards against the two drifting apart — the reason the mapper is a wrapper
		// and not a second loop.
		const envelope = {
			stats: [resident({}), resident({ call_id: "" })],
		};
		expect(mapZadarmaPendingRecordings(envelope)).toEqual(
			scanZadarmaStatistics(envelope)?.recordings,
		);
		expect(mapZadarmaPendingRecordings({ stats: "nope" })).toBeNull();
		expect(scanZadarmaStatistics({ stats: "nope" })).toBeNull();
	});
});
