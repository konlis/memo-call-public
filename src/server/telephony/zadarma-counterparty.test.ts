import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { mapZadarmaCounterparties } from "~/server/telephony/zadarma-counterparty";

/**
 * Unit tests for the one module allowed to read `clid` / `destination` out of
 * `/v1/statistics/pbx/?version=2` (FR-025).
 *
 * PROVENANCE OF THE FIXTURES (`lessons.md` requires it of any frozen literal).
 * The SHAPES are live — measured on 2026-10-19 and recorded, with placeholders
 * in place of every number, in `context/changes/caller-identity-in-archive/
 * spike.md`: an inbound call spans a trunk leg (`sip: "0"`) and an extension
 * leg (`sip: "100"`) with an IDENTICAL `clid` of the form `"Name" <+48…>` and
 * `destination` = the user's own DID as a JSON NUMBER; an outbound call has ONE
 * leg whose `clid` is the user's own GSM (`"" <+…>`) and whose `destination`
 * is the dialled party as a JSON NUMBER; a missed inbound call adds a
 * `sip: "Voice mail (8500)"` leg. The NUMBERS below are placeholders, never
 * anyone's real number — this file lands in git history and in every PR diff
 * shipped to the CI reviewer.
 */

const INBOUND_ID = "in_3e5854dd574d2fa0cc66bff5360d64a88bc5b465";
const VOICEMAIL_ID = "in_9d66fd4f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";
const OUTBOUND_ID = "out_4694c79062ff9e0cac2bd7783749f5ef1b500190";

/** Placeholders, in the roles `spike.md` names. */
const COUNTERPARTY = "500100200"; // the other party (Polish mobile shape)
const OWN_DID = 48172000000; // the user's DID, as the vendor renders it: a number
const OWN_GSM = "500100300"; // USER_FORWARD_NUMBER
const DIALLED = 48600700800; // outbound `destination`, a number

function inboundLeg(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		call_id: "1792428177.2940004",
		sip: "0",
		callstart: "2026-10-19 18:42:57",
		clid: `"Optimate Labs" <+48${COUNTERPARTY}>`,
		destination: OWN_DID,
		disposition: "answered",
		seconds: 9,
		is_recorded: "false",
		pbx_call_id: INBOUND_ID,
		...over,
	};
}

function outboundLeg(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		call_id: "1792426717.2547695",
		sip: `+48${OWN_GSM}`,
		callstart: "2026-10-19 18:18:39",
		clid: `"" <+48${OWN_GSM}>`,
		destination: DIALLED,
		disposition: "answered",
		seconds: 45,
		is_recorded: "false",
		pbx_call_id: OUTBOUND_ID,
		...over,
	};
}

function envelope(stats: unknown): Record<string, unknown> {
	return { status: "success", stats };
}

describe("mapZadarmaCounterparties — envelope shape", () => {
	// `[]`, `null` and "no entry" are THREE different answers; see the module
	// header. Collapsing any two of them either fails the sweep forever or
	// leaves conversations `pending` forever.
	it("returns null for anything that is not an object", () => {
		expect(mapZadarmaCounterparties(null)).toBeNull();
		expect(mapZadarmaCounterparties("stats")).toBeNull();
		expect(mapZadarmaCounterparties(undefined)).toBeNull();
	});

	it("returns null when `stats` is present but not an array", () => {
		expect(mapZadarmaCounterparties(envelope({ 0: inboundLeg() }))).toBeNull();
		expect(mapZadarmaCounterparties(envelope("none"))).toBeNull();
	});

	it("treats an absent `stats` key as an empty window", () => {
		expect(mapZadarmaCounterparties({ status: "success" })).toEqual([]);
		expect(mapZadarmaCounterparties(envelope([]))).toEqual([]);
	});

	it("skips non-object entries and rows with a malformed pbx_call_id", () => {
		const stats = [
			null,
			"x",
			inboundLeg({ pbx_call_id: "in_short" }),
			inboundLeg({ pbx_call_id: `${INBOUND_ID}f` }), // 41 hex
			inboundLeg({ pbx_call_id: 12345 }),
			inboundLeg(),
		];
		expect(mapZadarmaCounterparties(envelope(stats))).toEqual([
			{
				callSid: INBOUND_ID,
				outcome: "known",
				rawNumber: `+48${COUNTERPARTY}`,
				direction: "inbound",
				nameHint: "Optimate Labs",
			},
		]);
	});

	// NOT `withheld`: the resolver reads "no entry" as "try again next sweep".
	it("emits NO entry for a call that has no row (never a withheld one)", () => {
		const mapped = mapZadarmaCounterparties(envelope([inboundLeg()]));
		expect(mapped).toHaveLength(1);
		expect(mapped?.some((r) => r.callSid === OUTBOUND_ID)).toBe(false);
	});
});

describe("mapZadarmaCounterparties — inbound: clid of any leg", () => {
	it("reads number and presentation name from clid; destination (own DID) is ignored", () => {
		const stats = [
			inboundLeg({ sip: "0", seconds: 9 }),
			inboundLeg({ call_id: "1792428178.2940034", sip: "100", seconds: 42 }),
		];
		const mapped = mapZadarmaCounterparties(envelope(stats));
		expect(mapped).toEqual([
			{
				callSid: INBOUND_ID,
				outcome: "known",
				rawNumber: `+48${COUNTERPARTY}`,
				direction: "inbound",
				nameHint: "Optimate Labs",
			},
		]);
		// The DID is on EVERY inbound row and must appear nowhere in the output.
		const serialized = JSON.stringify(mapped);
		expect(serialized).not.toContain(String(OWN_DID));
		expect(serialized).not.toContain(String(OWN_DID).slice(2));
	});

	it("gives the same answer under both leg orderings", () => {
		const trunk = inboundLeg({ sip: "0", seconds: 9 });
		const ext = inboundLeg({ call_id: "x.1", sip: "100", seconds: 42 });
		expect(mapZadarmaCounterparties(envelope([trunk, ext]))).toEqual(
			mapZadarmaCounterparties(envelope([ext, trunk])),
		);
	});

	it("handles the voicemail shape (trunk + `Voice mail (8500)` leg) the same way", () => {
		const stats = [
			inboundLeg({ pbx_call_id: VOICEMAIL_ID, sip: "0", seconds: 1 }),
			inboundLeg({
				pbx_call_id: VOICEMAIL_ID,
				call_id: "1792426798.2804166",
				sip: "Voice mail (8500)",
				seconds: 10,
			}),
		];
		expect(mapZadarmaCounterparties(envelope(stats))).toEqual([
			{
				callSid: VOICEMAIL_ID,
				outcome: "known",
				rawNumber: `+48${COUNTERPARTY}`,
				nameHint: "Optimate Labs",
				direction: "inbound",
			},
		]);
	});

	it("falls back to a later leg when the first leg's clid is unusable", () => {
		const stats = [
			inboundLeg({ clid: "" }),
			inboundLeg({ call_id: "x.1", sip: "100" }),
		];
		expect(mapZadarmaCounterparties(envelope(stats))?.[0]).toMatchObject({
			outcome: "known",
			rawNumber: `+48${COUNTERPARTY}`,
		});
	});

	it("accepts a foreign number and keeps its own country code", () => {
		const stats = [inboundLeg({ clid: '"ACME Inc" <+14155550100>' })];
		expect(mapZadarmaCounterparties(envelope(stats))).toEqual([
			{
				callSid: INBOUND_ID,
				outcome: "known",
				rawNumber: "+14155550100",
				nameHint: "ACME Inc",
				direction: "inbound",
			},
		]);
	});

	it("strips human separators and spells `00` as `+`", () => {
		for (const [clid, expected] of [
			['"X" <+48 500 100 200>', "+48500100200"],
			['"X" <0048 500-100-200>', "+48500100200"],
			['"X" <(48) 500.100.200>', "48500100200"],
			['"X" <500100200>', "500100200"],
		] as const) {
			expect(
				mapZadarmaCounterparties(envelope([inboundLeg({ clid })]))?.[0],
			).toMatchObject({ outcome: "known", rawNumber: expected });
		}
	});

	it("reads a bare number with no angle brackets", () => {
		expect(
			mapZadarmaCounterparties(
				envelope([inboundLeg({ clid: "+48500100200" })]),
			)?.[0],
		).toEqual({
			callSid: INBOUND_ID,
			outcome: "known",
			rawNumber: "+48500100200",
			direction: "inbound",
		});
	});
});

describe("mapZadarmaCounterparties — withheld (CLIR and friends)", () => {
	it.each([
		["empty clid", ""],
		["Anonymous", '"Anonymous" <anonymous>'],
		["empty brackets", '"" <>'],
		["letters only", '"Unknown" <unknown>'],
		["a digit only inside the name", '"Biuro 24" <anonymous>'],
	])("yields withheld for %s (no digit where the number belongs)", (_label, clid) => {
		expect(mapZadarmaCounterparties(envelope([inboundLeg({ clid })]))).toEqual([
			{ callSid: INBOUND_ID, outcome: "withheld" },
		]);
	});

	// impl-review F2 (2026-10-20): digits the mapper cannot read are vendor
	// format drift, not CLIR — `withheld` is terminal, so storing drift as it
	// would make every later call "operator gave no number", silently.
	it.each([
		["too few digits", '"X" <+48123>'],
		["too many digits", '"X" <+1234567890123456>'],
		["digits glued to letters", '"X" <tel48500100200>'],
	])("yields unparsed for %s (digits, but not a number)", (_label, clid) => {
		expect(mapZadarmaCounterparties(envelope([inboundLeg({ clid })]))).toEqual([
			{ callSid: INBOUND_ID, outcome: "unparsed" },
		]);
	});

	it("yields withheld when clid is absent or null, unparsed when it has an unexpected type", () => {
		const noClid = inboundLeg();
		delete noClid.clid;
		expect(mapZadarmaCounterparties(envelope([noClid]))).toEqual([
			{ callSid: INBOUND_ID, outcome: "withheld" },
		]);
		expect(
			mapZadarmaCounterparties(envelope([inboundLeg({ clid: null })])),
		).toEqual([{ callSid: INBOUND_ID, outcome: "withheld" }]);
		for (const clid of [true, {}, ["+48500100200"]]) {
			expect(
				mapZadarmaCounterparties(envelope([inboundLeg({ clid })])),
			).toEqual([{ callSid: INBOUND_ID, outcome: "unparsed" }]);
		}
	});

	// Measured shape is a string, but a vendor that ever sent a bare JSON
	// number (as it does for `destination`) would still be read, not dropped.
	it("reads a bare numeric clid the way it reads a numeric destination", () => {
		expect(
			mapZadarmaCounterparties(envelope([inboundLeg({ clid: 48500100200 })])),
		).toEqual([
			{
				callSid: INBOUND_ID,
				outcome: "known",
				rawNumber: "48500100200",
				direction: "inbound",
			},
		]);
	});

	it("a withheld resolution carries exactly two keys — nothing a number or name could ride on", () => {
		const [res] =
			mapZadarmaCounterparties(envelope([inboundLeg({ clid: "" })])) ?? [];
		expect(Object.keys(res ?? {}).sort()).toEqual(["callSid", "outcome"]);
	});
});

describe("mapZadarmaCounterparties — the presentation name", () => {
	it("omits the hint when the quoted part is blank", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([inboundLeg({ clid: `"   " <+48${COUNTERPARTY}>` })]),
			) ?? [];
		expect(res).toEqual({
			callSid: INBOUND_ID,
			outcome: "known",
			rawNumber: `+48${COUNTERPARTY}`,
			direction: "inbound",
		});
		expect(Object.keys(res ?? {})).not.toContain("nameHint");
	});

	it("omits the hint when it merely restates the number", () => {
		for (const name of [
			`+48${COUNTERPARTY}`,
			`48${COUNTERPARTY}`,
			`0048 ${COUNTERPARTY}`,
			"+48 500 100 200",
			COUNTERPARTY,
		]) {
			const [res] =
				mapZadarmaCounterparties(
					envelope([inboundLeg({ clid: `"${name}" <+48${COUNTERPARTY}>` })]),
				) ?? [];
			expect(Object.keys(res ?? {}), name).not.toContain("nameHint");
		}
	});

	it("keeps a hint that is a DIFFERENT number (it is information, not a restatement)", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([inboundLeg({ clid: `"+48600700800" <+48${COUNTERPARTY}>` })]),
			) ?? [];
		expect(res).toMatchObject({ nameHint: "+48600700800" });
	});

	it("trims and caps the hint at 60 characters", () => {
		const long = "A".repeat(80);
		const [res] =
			mapZadarmaCounterparties(
				envelope([inboundLeg({ clid: `"  ${long}  " <+48${COUNTERPARTY}>` })]),
			) ?? [];
		expect(res).toMatchObject({ nameHint: "A".repeat(60) });
	});

	it("drops bidi controls and turns control characters into spaces", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([
					inboundLeg({
						clid: `"\u202EACME\u2066 Inc\u2069\u200F\tPL\u0000" <+48${COUNTERPARTY}>`,
					}),
				]),
			) ?? [];
		expect(res).toMatchObject({ nameHint: "ACME Inc PL" });
	});

	it("omits a hint made only of control characters", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([
					inboundLeg({ clid: `"\u202E\u200F\u0007" <+48${COUNTERPARTY}>` }),
				]),
			) ?? [];
		expect(Object.keys(res ?? {})).not.toContain("nameHint");
	});

	it("omits a hint made only of zero-width characters (U+200B, U+FEFF, U+2060)", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([
					inboundLeg({ clid: `"\u200B\uFEFF\u2060" <+48${COUNTERPARTY}>` }),
				]),
			) ?? [];
		expect(res).toMatchObject({ outcome: "known" });
		expect(Object.keys(res ?? {})).not.toContain("nameHint");
	});

	it("takes the number from the angle part AFTER the name, never from a <…> inside it", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([
					inboundLeg({ clid: `"Biuro <22 123 45 67>" <+48${COUNTERPARTY}>` }),
				]),
			) ?? [];
		expect(res).toMatchObject({
			outcome: "known",
			rawNumber: `+48${COUNTERPARTY}`,
		});
	});

	it("a non-number <…> inside the name does not turn a real number into withheld", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([inboundLeg({ clid: `"Firma <X>" <+48${COUNTERPARTY}>` })]),
			) ?? [];
		expect(res).toMatchObject({
			outcome: "known",
			rawNumber: `+48${COUNTERPARTY}`,
		});
	});
});

describe("mapZadarmaCounterparties — outbound: destination of the longest leg", () => {
	/**
	 * The load-bearing outbound test. MEASURED (`spike.md`): on an `out_` leg
	 * `clid` is the USER'S OWN GSM — the callback rings it first — and the
	 * dialled party is `destination`, a JSON number. The "clid in both
	 * directions" rule that this test refutes would have stored the owner's
	 * number on every call they placed.
	 */
	it("reads destination (a JSON number) and never the clid (the user's own GSM)", () => {
		const mapped = mapZadarmaCounterparties(envelope([outboundLeg()]));
		expect(mapped).toEqual([
			{
				callSid: OUTBOUND_ID,
				outcome: "known",
				rawNumber: String(DIALLED),
				direction: "outbound",
			},
		]);
		const serialized = JSON.stringify(mapped);
		expect(serialized).not.toContain(OWN_GSM);
	});

	it("sets no presentation hint for an outbound call, even if clid carries one", () => {
		const [res] =
			mapZadarmaCounterparties(
				envelope([outboundLeg({ clid: `"Me Myself" <+48${OWN_GSM}>` })]),
			) ?? [];
		expect(res).toEqual({
			callSid: OUTBOUND_ID,
			outcome: "known",
			rawNumber: String(DIALLED),
			direction: "outbound",
		});
		expect(JSON.stringify(res)).not.toContain("Me Myself");
	});

	it("accepts a string destination too, separators included", () => {
		expect(
			mapZadarmaCounterparties(
				envelope([outboundLeg({ destination: "+48 600 700 800" })]),
			)?.[0],
		).toMatchObject({ outcome: "known", rawNumber: "+48600700800" });
	});

	it("picks the LONGEST leg's destination when several legs exist, under both orderings", () => {
		const ring = outboundLeg({
			call_id: "a.1",
			seconds: 4,
			destination: 48111222333,
		});
		const talk = outboundLeg({ call_id: "a.2", seconds: 45 });
		for (const stats of [
			[ring, talk],
			[talk, ring],
		]) {
			expect(mapZadarmaCounterparties(envelope(stats))?.[0]).toMatchObject({
				rawNumber: String(DIALLED),
			});
		}
	});

	it.each([
		["a float", 4860070080.5],
		["a negative", -48600700800],
		["too few digits", 123456],
		["too many digits", 1234567890123456],
		["an object", {}],
	])("yields unparsed when destination is %s (format drift, not withholding)", (_label, destination) => {
		expect(
			mapZadarmaCounterparties(envelope([outboundLeg({ destination })])),
		).toEqual([{ callSid: OUTBOUND_ID, outcome: "unparsed" }]);
	});

	it("yields withheld when destination is null", () => {
		expect(
			mapZadarmaCounterparties(envelope([outboundLeg({ destination: null })])),
		).toEqual([{ callSid: OUTBOUND_ID, outcome: "withheld" }]);
	});

	it("yields withheld when destination is absent", () => {
		const bare = outboundLeg();
		delete bare.destination;
		expect(mapZadarmaCounterparties(envelope([bare]))).toEqual([
			{ callSid: OUTBOUND_ID, outcome: "withheld" },
		]);
	});
});

describe("mapZadarmaCounterparties — several conversations in one window", () => {
	it("keeps conversations apart and resolves each by its own direction", () => {
		const stats = [
			inboundLeg({ sip: "0", seconds: 9 }),
			outboundLeg(),
			inboundLeg({ call_id: "x.2", sip: "100", seconds: 42 }),
		];
		const mapped = mapZadarmaCounterparties(envelope(stats));
		expect(mapped?.map((r) => r.callSid)).toEqual([INBOUND_ID, OUTBOUND_ID]);
		expect(mapped?.[0]).toMatchObject({ rawNumber: `+48${COUNTERPARTY}` });
		expect(mapped?.[1]).toMatchObject({ rawNumber: String(DIALLED) });
	});

	it("does not consult is_recorded — a processed (deleted-audio) call still resolves", () => {
		for (const value of ["false", false, "true", true, undefined, "garbage"]) {
			expect(
				mapZadarmaCounterparties(
					envelope([inboundLeg({ is_recorded: value })]),
				)?.[0],
			).toMatchObject({ outcome: "known" });
		}
	});
});

describe("zadarma-counterparty.ts source guard", () => {
	function code(): string {
		const source = readFileSync(
			new URL("./zadarma-counterparty.ts", import.meta.url),
			"utf8",
		);
		return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	}

	/**
	 * The half `depcruise` structurally cannot cover (`telephony-params-are-pure`
	 * sees IMPORTS; `console`, `process`, `fetch` are GLOBALS). One
	 * `console.error(JSON.stringify(row))` here would dump every caller's number
	 * and name into Fly's ~7-day log window — the only audit trail this system
	 * has — and pass the import rule cleanly. Copied from
	 * `zadarma-statistics.test.ts`, which pins the same property for its module.
	 */
	it("holds no egress primitive — no console, process or fetch", () => {
		const c = code();
		expect(c).toContain("mapZadarmaCounterparties"); // non-vacuous
		expect(c).not.toMatch(/\bconsole\b/);
		expect(c).not.toMatch(/\bprocess\b/);
		expect(c).not.toMatch(/\bfetch\b/);
	});

	/**
	 * A presentation NAME is free text no regex can redact. The mapper's only
	 * protection for it is structural: it never builds a string out of `clid`
	 * other than the `nameHint` field itself. A template literal or `throw`
	 * interpolating a row would be the first step toward a log line.
	 */
	it("never throws and never interpolates a row into a string", () => {
		const c = code();
		expect(c).not.toMatch(/\bthrow\b/);
		expect(c).not.toMatch(/\$\{[^}]*(?:clid|destination|row|leg)\b/);
	});
});
