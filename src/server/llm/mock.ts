import { type ZodSchema, z } from "zod";

import { ProviderError } from "~/server/_lib/provider-error";
import type { Analysis, Classification } from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";

// Direct process.env read (NOT through ~/env) is required: @t3-oss/env-nextjs
// parses process.env once at module import and caches the result. Tests that
// mutate process.env.MOCK_LLM_FORCE_ERROR mid-run would be invisible if we read
// env.MOCK_LLM_FORCE_ERROR. The env.js entry is kept for build-time validation
// and documentation; it is intentionally NOT the source-of-truth here.
const forceErrorSchema = z
	.enum(["transport", "rate_limited", "auth", "invalid_response", "refusal"])
	.optional();

const cannedAnalysis: Analysis = {
	summary:
		"Krótka rozmowa biznesowa: omówiono priorytety projektu i ustalono kolejne kroki.",
	keyInsights: [
		"Klient potwierdził budżet na Q3.",
		"Nowy wymóg integracji z systemem CRM.",
	],
	decisions: ["Przesuwamy demo na przyszły piątek."],
	actionItems: [
		"Przygotować mockup integracji CRM do środy.",
		"Wysłać podsumowanie e-mailem.",
	],
	candidateTags: ["crm", "demo", "q3-planning"],
};

const cannedClassification: Classification = {
	category: "praca",
	projectId: "mock-project-1",
};

export class MockLlmProvider implements LlmProvider {
	async generateStructured<T>(input: {
		prompt: string;
		schema: ZodSchema<T>;
	}): Promise<T> {
		const parsedForce = forceErrorSchema.safeParse(
			process.env.MOCK_LLM_FORCE_ERROR,
		);
		if (!parsedForce.success) {
			throw new ProviderError({
				code: "unknown",
				message: "invalid MOCK_LLM_FORCE_ERROR value",
			});
		}
		if (parsedForce.data) {
			throw new ProviderError({
				code: parsedForce.data,
				message: "forced via MOCK_LLM_FORCE_ERROR",
			});
		}

		const { schema } = input;
		// Identify the canned value by which one the supplied schema STRUCTURALLY
		// accepts (`safeParse`), NOT by module-reference identity (`schema ===
		// analysisSchema`). Reference equality is unreliable in the Next.js dev server:
		// the `llm` singleton is cached on `globalThis` (HMR-safe), so it captures the
		// schema reference at construction, but an HMR reload re-evaluates the schema
		// module and produces a NEW `analysisSchema` instance — desyncing the `===`
		// check and making every mock call throw "no canned value". `cannedAnalysis`
		// and `cannedClassification` are mutually exclusive across the two schemas
		// (each requires fields the other lacks), so acceptance is unambiguous. This
		// path is dev/test-only (prod uses the real Bedrock provider).
		for (const canned of [cannedAnalysis, cannedClassification]) {
			const parsed = schema.safeParse(canned);
			if (parsed.success) return parsed.data;
		}
		throw new ProviderError({
			code: "invalid_response",
			message: "MockLlmProvider has no canned value for the supplied schema",
		});
	}
}
