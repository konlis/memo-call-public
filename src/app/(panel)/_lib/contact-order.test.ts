import { describe, expect, it } from "vitest";

import { sortByPolishName } from "./contact-order";

// The fixture is deliberately the exact set that exposes SQLite's BINARY
// collation. Measured against the real migrated schema, `ORDER BY name ASC`
// returns: Basia | Zofia | anna | ąla | Ćma | Łukasz — uppercase before
// lowercase, every Polish diacritic after all of ASCII. This suite pins the
// order a Polish reader expects instead, so the promise the UI makes is
// checked rather than assumed (impl-review phase 3, F6).
const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);
const rows = (...ns: string[]) => ns.map((name) => ({ name }));

describe("sortByPolishName", () => {
	it("orders Polish diacritics inside the alphabet, not after it", () => {
		const sorted = sortByPolishName(
			rows("Zofia", "anna", "Łukasz", "Ćma", "Basia", "ąla"),
		);
		expect(names(sorted)).toEqual([
			"anna",
			"ąla",
			"Basia",
			"Ćma",
			"Łukasz",
			"Zofia",
		]);
	});

	it("does not let case decide the order", () => {
		// The BINARY failure mode: "Zofia" < "anna" because Z is byte 90 and a
		// is byte 97. Case must not outrank the letter itself.
		expect(names(sortByPolishName(rows("zofia", "Anna")))).toEqual([
			"Anna",
			"zofia",
		]);
	});

	it("returns a new array and leaves the input untouched", () => {
		// The input is react-query's cached array; sorting it in place would
		// mutate the cache under other consumers.
		const input = rows("Zofia", "Anna");
		const sorted = sortByPolishName(input);
		expect(sorted).not.toBe(input);
		expect(names(input)).toEqual(["Zofia", "Anna"]);
	});

	it("handles an empty list", () => {
		expect(sortByPolishName([])).toEqual([]);
	});
});
