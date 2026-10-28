import { llm } from "~/server/llm";
import { type Analysis, analysisSchema } from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";

export type AnalyzeInput = {
	transcript: string;
	/**
	 * Existing tag names handed to the model as the namespace to reuse
	 * (`tag-vocabulary-control`, phase 5). The model is stateless per call, so
	 * without this it draws every tag from the whole Polish language and
	 * `faktura` / `faktury` / `fakturowanie` become three tags for one topic.
	 *
	 * REQUIRED, empty array allowed. Required is the point: an optional field
	 * lets the next call site of `analyze()` ship without a dictionary and never
	 * notice, which is exactly how the open vocabulary arose. An empty array is
	 * the honest value for a fresh instance that has no tags yet, and it emits
	 * NO dictionary section at all — an empty heading is a worse instruction
	 * than none ("here are the existing tags: " followed by nothing invites the
	 * model to conclude the namespace is empty by design).
	 *
	 * Composition (the ≥2-uses / at-most-40 slice) is the caller's decision and
	 * lives in `src/server/jobs/vocabulary.ts`; this layer only formats what it
	 * is given, exactly as `classify()` only formats the project list.
	 */
	vocabulary: ReadonlyArray<string>;
};
export type AnalyzeOptions = { provider?: LlmProvider };

function buildAnalyzePrompt(input: AnalyzeInput): string {
	const lines = [
		"Jesteś asystentem analizującym polskie rozmowy biznesowe.",
		"Na podstawie poniższego transkryptu zwróć JSON zgodny ze schematem:",
		"- summary: zwięzłe podsumowanie (≤300 słów)",
		"- keyInsights: lista najważniejszych obserwacji",
		"- decisions: lista podjętych decyzji",
		"- actionItems: lista konkretnych zadań do wykonania",
		"- candidateTags: 3–5 tagów charakteryzujących rozmowę (lowercase, ASCII)",
	];

	// The dictionary CONSTRAINS THE OUTPUT SPACE; it does not teach the model
	// what a correct answer looks like. That distinction is what keeps it on the
	// right side of the product rule against learning loops — see CLAUDE.md,
	// "Tag vocabulary in the analyze() prompt".
	if (input.vocabulary.length > 0) {
		lines.push(
			"",
			"Tagi już używane w tym panelu (posortowane od najczęstszych):",
			// Interpolated raw, and that is safe only because of an invariant owned
			// by ANOTHER module: every write path canonicalizes through
			// `normalizeTag`, whose output alphabet is `[a-z0-9-]` — no newline, no
			// quote, no space, so a name cannot forge a prompt line. Worth stating
			// here because tag names are the one part of this prompt that travels
			// BETWEEN conversations (a caller's words become a transcript, then a
			// candidate tag, then a dictionary entry in every later prompt). If
			// anyone ever widens that alphabet — "let tag names keep spaces" is the
			// obvious future request — this line needs escaping first.
			input.vocabulary.map((name) => `  - ${name}`).join("\n"),
			// The three lines below replace a two-line instruction that measurably
			// over-consolidated on prod (2026-09-15, criterion 5.9): a conversation
			// about buying and importing a car was tagged `konsultacja`,
			// `krotka-rozmowa`, `sprzedaz` — three of the emptiest names on the list
			// — and coined nothing. Both original lines pushed that way: "use one
			// from the list even if you would phrase it differently" reads as
			// permission for a LOOSE match (it was meant to forbid spelling
			// variants), and "create a new tag ONLY when…" framed a new name as an
			// exception needing justification, so the safe move was always the list.
			// The dictionary exists to stop VARIANTS OF ONE CONCEPT, not to narrow
			// which subjects may be named; these lines say exactly that.
			"Jeśli któraś z tych nazw trafnie nazywa temat rozmowy, użyj jej zamiast tworzyć własny wariant tej samej nazwy.",
			"Jeśli rozmowa dotyczy tematu, którego żadna z nich nie nazywa — utwórz nową nazwę. To jest oczekiwane, nie wyjątek.",
			"Nie wybieraj tagu tylko dlatego, że jest na liście: lista ujednolica nazewnictwo, nie zastępuje treści rozmowy.",
		);
	}

	lines.push("", "Transkrypt:", input.transcript);

	return lines.join("\n");
}

export async function analyze(
	input: AnalyzeInput,
	opts: AnalyzeOptions = {},
): Promise<Analysis> {
	const provider = opts.provider ?? llm;
	const prompt = buildAnalyzePrompt(input);
	return provider.generateStructured({ prompt, schema: analysisSchema });
}
