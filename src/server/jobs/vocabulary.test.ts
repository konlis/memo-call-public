/**
 * Vocabulary composition + the degrade-to-empty contract
 * (`tag-vocabulary-control`, phase 5).
 *
 * The slice rule is pure, so it is tested directly against `RankedTag` rows.
 * `loadPromptVocabulary`'s failure path is tested against a stub reader here
 * (the mechanism); the two workers prove the SAME path against a real libsql
 * database and a real failing tag read (`worker.test.ts`, `reanalyze.test.ts`,
 * criterion 5.7) — a stub reader cannot show the job still lands.
 */
import { describe, expect, test, vi } from "vitest";

import {
	loadPromptVocabulary,
	selectPromptVocabulary,
	VOCABULARY_MAX_NAMES,
	VOCABULARY_MIN_USES,
} from "~/server/jobs/vocabulary";
import { MAX_TAG_LENGTH } from "~/server/tags/normalize";
import type { RankedTag } from "~/server/tags/rank";

function ranked(
	entries: ReadonlyArray<[name: string, count: number, userEdited?: boolean]>,
): RankedTag[] {
	return entries.map(([name, count, userEdited]) => ({
		name,
		count,
		isUserEdited: userEdited ?? false,
	}));
}

describe("selectPromptVocabulary", () => {
	test("admits a user-edited name at ANY count, in its rank position", () => {
		// The one name a person deliberately curated must not be the one name the
		// model never sees — the merge path already made this trade for the cloud
		// ("a curated tag is worth showing"). Same predicate here (impl-review F1).
		const names = selectPromptVocabulary(
			ranked([
				["automatyzacja", 7],
				["system", 2],
				["jednorazowy", 1],
				["wykurowany", 1, true],
			]),
		);

		expect(names).toEqual(["automatyzacja", "system", "wykurowany"]);
		// NOT hoisted to the front: the prompt claims the list is sorted by
		// frequency, so a curated singleton stays where the ranking puts it.
		expect(names.indexOf("wykurowany")).toBeGreaterThan(
			names.indexOf("system"),
		);
	});

	test("the cap drops the lowest-ranked EARNED name, never a curated one", () => {
		// A curated singleton sorts last (count desc), so a naive filter-then-slice
		// would cut it first — exactly backwards.
		const entries: Array<[string, number, boolean?]> = Array.from(
			{ length: VOCABULARY_MAX_NAMES },
			(_, i) => [`tag-${String(i).padStart(2, "0")}`, 100 - i],
		);
		entries.push(["wykurowany", 1, true]);

		const names = selectPromptVocabulary(ranked(entries));

		expect(names).toHaveLength(VOCABULARY_MAX_NAMES);
		expect(names).toContain("wykurowany");
		// The sacrificed name is the weakest EARNED one, i.e. the ranking's tail.
		expect(names).not.toContain(
			`tag-${String(VOCABULARY_MAX_NAMES - 1).padStart(2, "0")}`,
		);
		expect(names[0]).toBe("tag-00");
	});

	test("drops names below the use threshold, keeps order", () => {
		const names = selectPromptVocabulary(
			ranked([
				["automatyzacja", 7],
				["e-commerce", 3],
				["system", 2],
				["crm", 1],
				["demo", 1],
			]),
		);

		// Measured on prod: 164 of 184 names were used exactly once. Padding the
		// list to a fixed size with those would present alphabetical noise to the
		// model as "the existing vocabulary".
		expect(names).toEqual(["automatyzacja", "e-commerce", "system"]);
		expect(VOCABULARY_MIN_USES).toBe(2);
	});

	test("caps the list at the maximum, keeping the most used", () => {
		const oversized = ranked(
			Array.from({ length: VOCABULARY_MAX_NAMES + 5 }, (_, i) => [
				`tag-${String(i).padStart(2, "0")}`,
				100 - i,
			]),
		);

		const names = selectPromptVocabulary(oversized);

		expect(names).toHaveLength(VOCABULARY_MAX_NAMES);
		expect(names[0]).toBe("tag-00");
		expect(names.at(-1)).toBe(
			`tag-${String(VOCABULARY_MAX_NAMES - 1).padStart(2, "0")}`,
		);
		// The cap trims the TAIL of the ranking, never the head.
		expect(names).not.toContain(`tag-${VOCABULARY_MAX_NAMES}`);
	});

	test("skips a name longer than the stored bound, even if curated", () => {
		// Belt-and-braces against `normalize.ts`: the 40-name cap bounds the count,
		// not the bytes, so the prompt's size must not depend on another module
		// staying correct (impl-review F2).
		const tooLong = "x".repeat(MAX_TAG_LENGTH + 1);
		const names = selectPromptVocabulary(
			ranked([
				["automatyzacja", 7],
				[tooLong, 9],
				[`${tooLong}-curated`, 1, true],
			]),
		);

		expect(names).toEqual(["automatyzacja"]);
	});

	test("never offers an excluded name, whatever its count or flags", () => {
		const names = selectPromptVocabulary(
			ranked([
				["krotka-rozmowa", 30],
				["automatyzacja", 7],
				["poczta-glosowa", 3],
			]),
		);

		// Offering a name true of any short conversation is offering a free pass —
		// it matches everything and wins whenever the model is told to prefer the
		// list (prod, criterion 5.9).
		expect(names).not.toContain("krotka-rozmowa");
		// …and the carve-out is NOT "describes the form of the call": for a
		// voicemail, `poczta-glosowa` IS the subject, and blinding the model to the
		// settled name would bring its spelling variants back.
		expect(names).toEqual(["automatyzacja", "poczta-glosowa"]);
	});

	test("an excluded name is not resurrected by the user-edited gate", () => {
		// `isUserEdited` admits a name at any count (F1); exclusion must still win,
		// or renaming one conversation's tag to `krotka-rozmowa` would re-arm it.
		expect(
			selectPromptVocabulary(ranked([["krotka-rozmowa", 1, true]])),
		).toEqual([]);
	});

	test("no qualifying tags yields an empty list, not a padded one", () => {
		expect(
			selectPromptVocabulary(
				ranked([
					["crm", 1],
					["demo", 1],
				]),
			),
		).toEqual([]);
		expect(selectPromptVocabulary([])).toEqual([]);
	});
});

describe("loadPromptVocabulary", () => {
	test("returns the sliced names on a successful read", async () => {
		// Minimal stand-in for the drizzle chain `listTagsWithCounts` builds.
		const rows = [
			{ name: "automatyzacja", count: 7, anyEdited: 1 },
			{ name: "jednorazowy", count: 1, anyEdited: 0 },
		];
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({
						groupBy: () => ({
							orderBy: () => Promise.resolve(rows),
						}),
					}),
				}),
			}),
		} as never;

		await expect(
			loadPromptVocabulary(db, {
				userId: "me",
				jobId: "job-1",
				conversationId: "conv-1",
			}),
		).resolves.toEqual(["automatyzacja"]);
	});

	test("degrades to an empty list and logs when the read throws", async () => {
		const db = {
			select: () => {
				throw new Error("SQLITE_BUSY: database is locked");
			},
		} as never;

		const lines: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => {
			lines.push(String(l));
		});
		try {
			await expect(
				loadPromptVocabulary(db, {
					userId: "me",
					jobId: "job-9",
					conversationId: "conv-9",
				}),
			).resolves.toEqual([]);
		} finally {
			spy.mockRestore();
		}

		// Silent degradation would be the worst of both worlds: the tags stop
		// converging and nothing says so. Assert the line is PRESENT with the job
		// it belongs to, not merely that nothing threw.
		const events = lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.event === "job.vocabulary_unavailable");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			jobId: "job-9",
			conversationId: "conv-9",
			error: "SQLITE_BUSY: database is locked",
		});
	});
});
