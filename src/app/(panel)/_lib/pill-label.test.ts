import { describe, expect, it } from "vitest";

import { ambiguousContactNames, pillLabel } from "./pill-label";

// What these cases pin is the rule the docblock warns about, not the string
// formatting: ambiguity is derived from the HISTORY rows, so a pill stays
// disambiguated even when `contacts.list` is unavailable (full-plan
// impl-review, F1 + F4). A refactor that reached for the contact book instead
// would still pass a naive "two Mareks render differently" test while
// reintroducing the failure mode — hence the explicit unsigned-row cases.

const entry = (contactName: string | null) => ({ contactName });

describe("ambiguousContactNames", () => {
	it("names only what repeats", () => {
		const ambiguous = ambiguousContactNames([
			entry("Marek"),
			entry("Ala"),
			entry("Marek"),
		]);
		expect(ambiguous.has("Marek")).toBe(true);
		expect(ambiguous.has("Ala")).toBe(false);
	});

	it("ignores unsigned rows entirely", () => {
		// Two unsigned numbers are never ambiguous: `dialed_numbers` carries a
		// FULL unique index on (user, e164), so no two rows share a number, and
		// `null` is not a name that could collide with another `null`.
		const ambiguous = ambiguousContactNames([
			entry(null),
			entry(null),
			entry("Marek"),
		]);
		expect(ambiguous.size).toBe(0);
	});

	it("marks every occurrence, not just the ones after the first", () => {
		// The set is consulted per row, so a name seen three times must be in it
		// once and widen all three pills.
		const ambiguous = ambiguousContactNames([
			entry("Marek"),
			entry("Marek"),
			entry("Marek"),
		]);
		expect([...ambiguous]).toEqual(["Marek"]);
	});

	it("is empty for an empty history", () => {
		expect(ambiguousContactNames([]).size).toBe(0);
	});
});

describe("pillLabel", () => {
	const none: ReadonlySet<string> = new Set();

	it("formats the number when there is no contact", () => {
		expect(pillLabel(null, "+48600100200", none)).toBe("+48 600 100 200");
	});

	it("shows the bare name when it is unique", () => {
		expect(pillLabel("Marek", "+48600100200", none)).toBe("Marek");
	});

	it("widens a colliding name with its number", () => {
		const ambiguous = new Set(["Marek"]);
		expect(pillLabel("Marek", "+48600100200", ambiguous)).toBe(
			"Marek · +48 600 100 200",
		);
		// Same separator the "Kontakt" select uses, so the two controls
		// disambiguate identically.
		expect(pillLabel("Marek", "+48600100201", ambiguous)).toBe(
			"Marek · +48 600 100 201",
		);
	});

	it("leaves an unsigned row alone even when some other name collides", () => {
		expect(pillLabel(null, "+48600100200", new Set(["Marek"]))).toBe(
			"+48 600 100 200",
		);
	});
});
