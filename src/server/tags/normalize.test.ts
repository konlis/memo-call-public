import { describe, expect, it, test } from "vitest";

import {
	MAX_TAG_LENGTH,
	normalizeTag,
	normalizeTags,
} from "~/server/tags/normalize";

describe("normalizeTag — canonical transforms", () => {
	it.each([
		// label, input, expected canonical form
		["lowercase", "Praca", "praca"],
		["already canonical passthrough", "follow-up", "follow-up"],
		["trim surrounding whitespace", "  praca  ", "praca"],
		["single Polish diacritic", "ćma", "cma"],
		["all Polish diacritics", "ąćęłńóśżź", "acelnoszz"],
		["uppercase Polish diacritics", "ŻÓŁĆ", "zolc"],
		// Non-Polish accents are NOT transliterated — they fall through to the
		// invalid-char strip (ASCII-only canonical form). Pins the boundary so a
		// future generic-Unicode-folding change can't silently alter it.
		["non-Polish accent stripped, not folded", "café", "caf"],
		["whitespace → dash", "spotkanie z klientem", "spotkanie-z-klientem"],
		["underscore → dash", "follow_up", "follow-up"],
		["mixed whitespace+underscore run → single dash", "a _  b", "a-b"],
		["collapse repeated dashes", "a---b", "a-b"],
		["strip invalid chars", "tag!@#name", "tagname"],
		["strip punctuation, keep digits", "v2.0 release", "v20-release"],
		["trim leading/trailing dashes", "-tag-", "tag"],
		["realistic mixed input", "  Pilne!! Zadanie  ", "pilne-zadanie"],
	])("%s", (_label, input, expected) => {
		expect(normalizeTag(input)).toBe(expected);
	});
});

describe("normalizeTag — empty-after-normalize → null (never throws)", () => {
	it.each([
		["empty string", ""],
		["only whitespace", "   "],
		["only punctuation", "!!!"],
		["only underscores", "___"],
		["em dash (outside [a-z0-9-])", "—"],
		["only a bullet glyph", "•"],
	])("%s → null", (_label, input) => {
		expect(normalizeTag(input)).toBeNull();
	});
});

describe("normalizeTag — length bound", () => {
	test("accepts a canonical name at exactly the bound", () => {
		const raw = "a".repeat(MAX_TAG_LENGTH);
		expect(normalizeTag(raw)).toBe(raw);
	});

	test("rejects one character past the bound, the same way an empty one is rejected", () => {
		// null, NOT a truncated fragment: a silently-cut name is a different tag
		// wearing the same prefix. `normalizeTags` drops it exactly as it drops a
		// punctuation-only name, so an over-long LLM candidate costs one tag —
		// never the whole analysis (impl-review phase 5, F2).
		expect(normalizeTag("a".repeat(MAX_TAG_LENGTH + 1))).toBeNull();
	});

	test("the bound applies to the CANONICAL form, not the raw input", () => {
		// Punctuation is stripped before the measurement, so a long raw string
		// whose canonical form fits is accepted.
		const raw = `${"!".repeat(100)}faktury${"!".repeat(100)}`;
		expect(normalizeTag(raw)).toBe("faktury");
	});

	test("normalizeTags drops the over-long name and keeps the rest", () => {
		expect(
			normalizeTags(["faktury", "b".repeat(MAX_TAG_LENGTH + 1), "wdrozenie"]),
		).toEqual(["faktury", "wdrozenie"]);
	});
});

describe("normalizeTags — list de-dup + first-occurrence order", () => {
	it("de-dupes names that collapse to the same canonical form", () => {
		expect(normalizeTags(["Praca", "praca", "PRACA"])).toEqual(["praca"]);
	});

	it("preserves first-occurrence order across duplicates", () => {
		expect(normalizeTags(["beta", "alfa", "beta"])).toEqual(["beta", "alfa"]);
	});

	it("drops entries that normalize to null", () => {
		expect(normalizeTags(["praca", "!!!", "dom", "   "])).toEqual([
			"praca",
			"dom",
		]);
	});

	it("merges distinct raw forms that share a canonical result", () => {
		expect(normalizeTags(["follow up", "follow-up", "follow_up"])).toEqual([
			"follow-up",
		]);
	});

	it("returns an empty array when every entry drops out", () => {
		expect(normalizeTags(["!!!", "   ", ""])).toEqual([]);
	});
});
