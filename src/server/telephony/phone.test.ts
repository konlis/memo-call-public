import { describe, expect, it } from "vitest";

import { normalizePolishE164 } from "~/server/telephony/phone";

describe("normalizePolishE164 — accepted shapes", () => {
	it.each([
		// label, input, expected E.164
		["already E.164 passthrough", "+48600100200", "+48600100200"],
		["bare 9-digit national → +48", "600100200", "+48600100200"],
		["0048 international-access form", "0048600100200", "+48600100200"],
		["48 country code without +", "48600100200", "+48600100200"],
		["+48 with spaces", "+48 600 100 200", "+48600100200"],
		["+48 with dashes", "+48-600-100-200", "+48600100200"],
		["national with spaces", "600 100 200", "+48600100200"],
		["national with parens/dashes", "(600) 100-200", "+48600100200"],
		// A national number that itself starts with 48 is a valid 9-digit number.
		["9-digit number starting with 48", "481234567", "+48481234567"],
	])("%s", (_label, input, expected) => {
		expect(normalizePolishE164(input)).toBe(expected);
	});
});

describe("normalizePolishE164 — rejected shapes (→ null, never throws)", () => {
	it.each([
		["empty string", ""],
		["too short (8 national digits)", "60010020"],
		["too long (10 national digits)", "6001002000"],
		["+48 too short", "+4860010020"],
		["+48 too long", "+486001002000"],
		["letters", "60010020a"],
		["other country code with +", "+12025550123"],
		["other country code without + (wrong length)", "1202555012"],
		["only a plus", "+"],
		["just text", "zadzwoń"],
		["48 with wrong national length", "4860010020"],
	])("%s → null", (_label, input) => {
		expect(normalizePolishE164(input)).toBeNull();
	});
});
