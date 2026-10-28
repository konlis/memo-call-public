/**
 * `analyze()` prompt construction (`tag-vocabulary-control`, phase 5).
 *
 * The only observable output of this layer is the PROMPT — the schema and the
 * return shape are unchanged by phase 5 — so the provider stub captures it and
 * the assertions read it. Pure functions, no DB, no network.
 */
import { describe, expect, expectTypeOf, test } from "vitest";

import { type AnalyzeInput, analyze } from "~/server/llm/analyze";
import type { Analysis } from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";

const CANNED: Analysis = {
	summary: "Podsumowanie.",
	keyInsights: [],
	decisions: [],
	actionItems: [],
	candidateTags: ["faktury"],
};

/** Captures the prompt the service builds; returns a schema-valid analysis. */
function capturingProvider(): {
	provider: LlmProvider;
	prompts: string[];
} {
	const prompts: string[] = [];
	const provider: LlmProvider = {
		async generateStructured({ prompt }) {
			prompts.push(prompt);
			return CANNED as never;
		},
	};
	return { provider, prompts };
}

function onlyPrompt(prompts: string[]): string {
	expect(prompts).toHaveLength(1);
	return prompts[0] as string;
}

describe("analyze prompt — tag vocabulary", () => {
	test("emits every passed tag name, and the reuse instruction", async () => {
		const { provider, prompts } = capturingProvider();

		await analyze(
			{
				transcript: "Rozmowa o fakturach i wdrożeniu.",
				vocabulary: ["faktury", "wdrozenie", "automatyzacja"],
			},
			{ provider },
		);

		const prompt = onlyPrompt(prompts);
		for (const name of ["faktury", "wdrozenie", "automatyzacja"]) {
			expect(prompt).toContain(name);
		}
		// The names alone are not the feature — a list with no instruction is just
		// noise in the context window. Assert the instruction that makes them
		// binding, and the escape hatch that keeps a genuinely new topic nameable.
		expect(prompt).toContain("użyj jej zamiast tworzyć własny wariant");
		// The escape hatch must be stated as EXPECTED, not as an exception. The
		// first wording ("create a new tag only when…") over-consolidated on prod:
		// a car-import conversation came back with three of the emptiest dictionary
		// names and no new one (criterion 5.9, 2026-09-15).
		expect(prompt).toContain("utwórz nową nazwę. To jest oczekiwane");
		expect(prompt).toContain(
			"Nie wybieraj tagu tylko dlatego, że jest na liście",
		);
		// The clause that licensed the loose match must be gone, not merely
		// outweighed by the new text.
		expect(prompt).not.toContain("nawet gdy sformułowałbyś go inaczej");
		// Ordering is load-bearing: `listTagsWithCounts` sorts by count, and the
		// prompt says "od najczęstszych", so the list must not be re-sorted here.
		expect(prompt.indexOf("faktury")).toBeLessThan(prompt.indexOf("wdrozenie"));
		// The transcript still reaches the model, after the dictionary.
		expect(prompt).toContain("Rozmowa o fakturach i wdrożeniu.");
		expect(prompt.indexOf("automatyzacja")).toBeLessThan(
			prompt.indexOf("Rozmowa o fakturach"),
		);
	});

	test("empty vocabulary emits NO dictionary section", async () => {
		const { provider, prompts } = capturingProvider();

		await analyze(
			{ transcript: "Pierwsza rozmowa na świeżej instancji.", vocabulary: [] },
			{ provider },
		);

		const prompt = onlyPrompt(prompts);
		// An empty heading is a worse instruction than no heading: it tells the
		// model the namespace is deliberately empty. Neither the heading nor the
		// instructions that depend on it may appear.
		expect(prompt).not.toContain("Tagi już używane");
		expect(prompt).not.toContain("użyj jej zamiast tworzyć własny wariant");
		expect(prompt).not.toContain("utwórz nową nazwę. To jest oczekiwane");
		expect(prompt).not.toContain("Nie wybieraj tagu tylko dlatego");
		// Positive control — the rest of the prompt is intact, so the assertions
		// above are about the dictionary section and not about an empty string.
		expect(prompt).toContain("candidateTags");
		expect(prompt).toContain("Pierwsza rozmowa na świeżej instancji.");
	});
});

describe("analyze input — the counterparty cannot reach the prompt (FR-025, A-5)", () => {
	test("AnalyzeInput has exactly the transcript and the vocabulary — no number, no hint", () => {
		// A TYPE assertion, checked by `tsc --noEmit`: the only way a number or a
		// presentation name could enter this prompt is through a new field on
		// the input, and this fails to compile the moment one is added. The
		// runtime twin (worker.test.ts / reanalyze.test.ts) drives the real
		// pipeline over a conversation that carries both and reads the prompt.
		expectTypeOf<keyof AnalyzeInput>().toEqualTypeOf<
			"transcript" | "vocabulary"
		>();
	});
});
