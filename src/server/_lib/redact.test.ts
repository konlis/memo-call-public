import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { redactPhoneNumbers, safeErrorMessage } from "~/server/_lib/redact";

/**
 * The "masks" / "leaves" matrix from the plan (§Sanitizer). Each "leaves" case
 * is a shape that really occurs in this system's log lines — ids, timestamps,
 * HTTP codes, durations — and a regex that ate them would train people to stop
 * reading the sanitized text.
 */
describe("redactPhoneNumbers — masks", () => {
	it.each([
		["+48 500 100 200", "international with spaces"],
		["500-100-200", "national with hyphens"],
		["(48) 500100200", "bracketed country code"],
		["0048 22 123 45 67", "00-prefixed landline"],
		["22 123 45 67", "bare landline with spaces"],
		["+48 500 100 200", "non-breaking spaces"],
		["+48\t500\t100\t200", "tab separators"],
		["+1 (415) 555-0100", "US shape with brackets and hyphen"],
		["48600100200", "unbroken 11-digit run"],
		["+48500100200", "unbroken E.164"],
	])("masks %s (%s)", (number) => {
		const out = redactPhoneNumbers(`cannot call ${number} from this account`);
		expect(out).toBe("cannot call <phone> from this account");
		expect(out.replace(/\D/g, "")).toBe("");
	});

	it("masks a `tel:` URI", () => {
		expect(redactPhoneNumbers("dial tel:+48500100200 now")).toBe(
			"dial tel:<phone> now",
		);
	});

	it("masks a whole caller-id, name included, as <caller>", () => {
		expect(
			redactPhoneNumbers('clid "Zenobia Testowa" <+48500100200> rejected'),
		).toBe("clid <caller> rejected");
	});

	it("masks a caller-id with an empty presentation name", () => {
		expect(redactPhoneNumbers('clid "" <+48500100200>')).toBe("clid <caller>");
	});

	it("masks every number in a line, not just the first", () => {
		expect(redactPhoneNumbers("from +48500100200 to 48600100200")).toBe(
			"from <phone> to <phone>",
		);
	});
});

describe("redactPhoneNumbers — leaves", () => {
	it.each([
		"pbx_call_id in_1788618987.123 not found",
		"recording out_4694c79062ff9e0cac2bd7783749f5ef1b500190 gone",
		"listRecordingsAwaitingCapture failed: HTTP 401",
		"window 2026-10-19 12:34:56 .. 2026-10-19 13:34:56",
		"at 2026-10-19T12:34:56.000Z",
		"page full (1000)",
		"leg 126 s",
		"sip 100",
		"job 3 of 12 retried after 5000 ms",
		'Failed query: select 1 from "t" where "a" < ? and "b" > ? order by 1',
		"<phone> after a second pass stays <phone>",
	])("leaves %s untouched", (line) => {
		expect(redactPhoneNumbers(line)).toBe(line);
	});
});

/**
 * KNOWN GAPS — pinned so the boundary is visible, not so it is defended. The
 * old `\d{6,}` mask in `zadarma.ts` caught the first two and the last two of
 * these, at the price of eating every call id and timestamp; the
 * word-boundary rule is the trade. If one of these starts failing, somebody
 * widened the regex — decide on purpose whether the ids survive.
 */
describe("redactPhoneNumbers — known gaps (documented, not defended)", () => {
	it.each([
		"tel48500100200",
		"48500100200abc",
		"+48.500.100.200",
		"0048500100200123456",
		"call 500100",
	])("does not mask %s", (line) => {
		expect(redactPhoneNumbers(line)).toBe(line);
	});
});

describe("safeErrorMessage", () => {
	it("returns a plain Error's message unchanged when it carries nothing to redact", () => {
		expect(safeErrorMessage(new Error("401 from provider"))).toBe(
			"401 from provider",
		);
	});

	it("stringifies a non-Error throwable", () => {
		expect(safeErrorMessage("boom")).toBe("boom");
		expect(safeErrorMessage(42)).toBe("42");
	});

	it("never yields an empty reason for an Error with an empty message", () => {
		expect(safeErrorMessage(new TypeError(""))).toBe("TypeError");
	});

	// impl-review phase 2, F1: this runs inside every worker `catch`; a throw
	// here skips the `status='failed'` write. TS says `message` is a string;
	// a library can still assign an object.
	it("never throws on an Error whose message is not a string", () => {
		const err = new Error("x");
		(err as { message: unknown }).message = { code: 42 };
		expect(safeErrorMessage(err)).toBe("Error");
	});

	it("never throws on a null-prototype object", () => {
		expect(safeErrorMessage(Object.create(null))).toBe("[unprintable error]");
	});

	it("masks BEFORE truncating, so a number straddling the cut cannot survive", () => {
		// 195 chars of prefix put the number across the 200-char boundary: a
		// truncate-then-mask order (the old `redactVendorMessage` shape) would
		// leave the first digits in the clear.
		const prefix = "x".repeat(195);
		const out = safeErrorMessage(new Error(`${prefix} +48500100200 tail`));
		expect(out).not.toMatch(/\d{3,}/);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBe(201);
	});

	it("does not append an ellipsis to a message under the cap", () => {
		expect(safeErrorMessage(new Error("short"), 10)).toBe("short");
	});

	it("drops a DrizzleQueryError's bound params — number AND name hint", () => {
		// The real class, not a literal mirroring our guess about its shape: the
		// `params:` line is drizzle-orm's own formatting (errors.js), and the point
		// of this test is that OUR cut matches THEIR message.
		const err = new DrizzleQueryError(
			'update "memo-call_conversations" set "counterparty_e164" = ?, "counterparty_name_hint" = ? where "call_sid" = ?',
			["+48500100200", "Zenobia Testowa", "in_1788618987.123"],
			new Error("SQLITE_BUSY: database is locked"),
		);
		// Positive control: the raw message really does leak both values.
		expect(err.message).toContain("+48500100200");
		expect(err.message).toContain("Zenobia Testowa");

		const out = safeErrorMessage(err);
		expect(out).not.toContain("500100200");
		expect(out).not.toContain("Zenobia");
		expect(out).not.toContain("params:");
		// The diagnostic survives — the failed statement is still named, AND the
		// SQLite reason from `cause` is carried along (F6).
		expect(out).toContain("Failed query");
		expect(out).toContain("counterparty_e164");
		expect(out).toContain("(cause: SQLITE_BUSY: database is locked)");
	});

	it("includes exactly one level of cause, sanitized, never the cause's cause", () => {
		const inner = new Error("deepest +48500100200", {
			cause: new Error("ignored level two"),
		});
		const out = safeErrorMessage(new Error("outer", { cause: inner }));
		expect(out).toBe("outer (cause: deepest <phone>)");
	});

	it("ignores a non-Error cause", () => {
		expect(
			safeErrorMessage(new Error("outer", { cause: "+48500100200" })),
		).toBe("outer");
	});

	it("still masks a number quoted in the SQL text itself, before the params tail", () => {
		const err = new DrizzleQueryError(
			"select 1 where x = '+48500100200'",
			[],
			new Error("boom"),
		);
		expect(safeErrorMessage(err)).not.toContain("500100200");
	});
});
