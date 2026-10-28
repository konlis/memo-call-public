import { describe, expect, test } from "vitest";

import { buildFtsMatchQuery } from "~/server/conversations/search";

// Pure-function contract of the MATCH builder. This proves the builder does
// what it says — NOT that the router calls it. The "is it wired" question is
// answered by the real-libsql suite in `api/routers/conversations.test.ts`
// (the Polish-vs-ASCII symmetry test goes through `conversations.list`),
// because a unit test of a pure function passes even when nobody calls it.
describe("buildFtsMatchQuery", () => {
	test("quotes every token and prefix-stars the last one when it is ≥ 3 chars", () => {
		expect(buildFtsMatchQuery("faktura klient")).toBe('"faktura" "klient"*');
	});

	test("a short last token is NOT prefix-starred (would match everything)", () => {
		expect(buildFtsMatchQuery("faktura za")).toBe('"faktura" "za"');
		expect(buildFtsMatchQuery("ab")).toBe('"ab"');
	});

	test("folds Polish diacritics the same way the index trigger does — including ł", () => {
		// `ł` is the one letter FTS5's remove_diacritics leaves alone; the trigger
		// folds it at index time and this must fold it at query time.
		expect(buildFtsMatchQuery("płatność")).toBe('"platnosc"*');
		expect(buildFtsMatchQuery("Dział Zażółć")).toBe('"dzial" "zazolc"*');
	});

	test("lowercases (the index is case-folded by the tokenizer)", () => {
		expect(buildFtsMatchQuery("FAKTURA")).toBe('"faktura"*');
	});

	test("FTS5 syntax never survives as syntax: it is split away or quoted", () => {
		// Operators, quotes, column filters, NEAR — all of it is either a separator
		// (dropped) or lands inside a quoted token where it is a literal.
		expect(buildFtsMatchQuery('"faktur*')).toBe('"faktur"*');
		expect(buildFtsMatchQuery("faktura OR umowa")).toBe(
			'"faktura" "or" "umowa"*',
		);
		expect(buildFtsMatchQuery("NEAR(a b)")).toBe('"near" "a" "b"');
		expect(buildFtsMatchQuery("body:faktura")).toBe('"body" "faktura"*');
		expect(buildFtsMatchQuery("-faktura ^umowa")).toBe('"faktura" "umowa"*');
		expect(buildFtsMatchQuery("cena: 12,50 zł")).toBe('"cena" "12" "50" "zl"');
	});

	test("no letter/digit token at all → null (caller decides; router = matches nothing)", () => {
		expect(buildFtsMatchQuery("--")).toBeNull();
		expect(buildFtsMatchQuery("**")).toBeNull();
		expect(buildFtsMatchQuery('" "')).toBeNull();
		expect(buildFtsMatchQuery("   ")).toBeNull();
	});

	test("keeps non-Polish unicode letters (the tokenizer folds them itself)", () => {
		expect(buildFtsMatchQuery("über café")).toBe('"über" "café"*');
	});
});
