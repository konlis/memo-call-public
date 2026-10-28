import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ProviderError } from "~/server/_lib/provider-error";
import { MockLlmProvider } from "~/server/llm/mock";
import { analysisSchema, classificationSchema } from "~/server/llm/schemas";

describe("MockLlmProvider", () => {
	// Regression for a real dev-server bug: the mock used to pick the canned value by
	// module-reference identity (`schema === analysisSchema`), which desyncs in the
	// Next.js dev server (globalThis-cached `llm` singleton holds a stale schema ref
	// across HMR) → every call threw "no canned value". The fix identifies the schema
	// STRUCTURALLY (safeParse). Prod is unaffected (real Bedrock provider).
	describe("structural schema identification", () => {
		const llm = new MockLlmProvider();

		it("returns a canned analysis for the analysis schema", async () => {
			const r = await llm.generateStructured({
				prompt: "x",
				schema: analysisSchema,
			});
			expect(r.summary).toBeTruthy();
			expect(Array.isArray(r.candidateTags)).toBe(true);
		});

		it("returns a canned classification for the classification schema", async () => {
			const r = await llm.generateStructured({
				prompt: "x",
				schema: classificationSchema,
			});
			expect(r.category).toBe("praca");
			expect(typeof r.projectId).toBe("string");
		});

		it("identifies by structure, NOT by reference (HMR-desync regression)", async () => {
			// A structurally-identical but DISTINCT schema instance — mimics the dev
			// server re-evaluating the schema module while the cached mock holds the old
			// reference. Under the old `schema === analysisSchema` check this threw
			// "no canned value"; structural identification accepts it.
			const freshAnalysisSchema = z.object({
				summary: z.string().max(2000),
				keyInsights: z.array(z.string()),
				decisions: z.array(z.string()),
				actionItems: z.array(z.string()),
				candidateTags: z.array(z.string()),
			});
			const r = await llm.generateStructured({
				prompt: "x",
				schema: freshAnalysisSchema,
			});
			expect(r.summary).toBeTruthy();
		});

		it("throws invalid_response when no canned value satisfies the schema", async () => {
			const unknownSchema = z.object({ totallyDifferent: z.number() });
			await expect(
				llm.generateStructured({ prompt: "x", schema: unknownSchema }),
			).rejects.toMatchObject({ code: "invalid_response" });
		});

		// Disjointness is the safety property the safeParse loop relies on: each canned
		// value must satisfy EXACTLY ONE schema, else identification (and its order)
		// becomes ambiguous. Pin it against the mock's REAL canned values so a future
		// schema edit that accidentally makes the two overlap fails here.
		it("the canned analysis is rejected by the classification schema (disjointness)", async () => {
			const analysis = await llm.generateStructured({
				prompt: "x",
				schema: analysisSchema,
			});
			expect(classificationSchema.safeParse(analysis).success).toBe(false);
		});

		it("the canned classification is rejected by the analysis schema (disjointness)", async () => {
			const classification = await llm.generateStructured({
				prompt: "x",
				schema: classificationSchema,
			});
			expect(analysisSchema.safeParse(classification).success).toBe(false);
		});
	});
	describe("with MOCK_LLM_FORCE_ERROR set to an invalid value (typo path)", () => {
		const original = process.env.MOCK_LLM_FORCE_ERROR;
		beforeEach(() => {
			process.env.MOCK_LLM_FORCE_ERROR = "transprt";
		});
		afterEach(() => {
			if (original === undefined) {
				delete process.env.MOCK_LLM_FORCE_ERROR;
			} else {
				process.env.MOCK_LLM_FORCE_ERROR = original;
			}
		});

		it("throws ProviderError with code 'unknown' (fail-loud, not silent fallthrough)", async () => {
			const llm = new MockLlmProvider();
			const promise = llm.generateStructured({
				prompt: "test",
				schema: analysisSchema,
			});
			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "unknown" });
		});
	});
});
