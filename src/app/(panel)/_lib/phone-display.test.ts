import { describe, expect, it } from "vitest";

import { formatForDisplay } from "./phone-display";

// Pure function, no DOM — `environment: 'node'` is enough, which is why this
// test exists even though the repo still has no `happy-dom` (impl-review
// phase 3, F2). What it pins is the PASS-THROUGH half of the contract: the
// docblock promises this module never decides what a valid number is, and two
// screens now rely on that. A regex that started "helpfully" reformatting or
// rejecting an unrecognized string would break `/call` and `/contacts` at once.
describe("formatForDisplay", () => {
	it("groups a Polish E.164 number", () => {
		expect(formatForDisplay("+48600100200")).toBe("+48 600 100 200");
	});

	it("passes a non-+48 number through untouched", () => {
		// Foreign numbers are not creatable today (`normalizePolishE164`), but
		// this module must not be the thing that enforces it.
		expect(formatForDisplay("+4917612345678")).toBe("+4917612345678");
	});

	it("passes a +48 number of the wrong length through untouched", () => {
		expect(formatForDisplay("+4860010020")).toBe("+4860010020");
		expect(formatForDisplay("+486001002000")).toBe("+486001002000");
	});

	it("passes an already-grouped or empty string through untouched", () => {
		// Idempotence matters: a value that has been through the formatter once
		// must survive a second pass unchanged.
		expect(formatForDisplay("+48 600 100 200")).toBe("+48 600 100 200");
		expect(formatForDisplay("")).toBe("");
	});
});
