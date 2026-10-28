import { describe, expect, it } from "vitest";

import {
	analysisSchema,
	categorySchema,
	classificationSchema,
} from "~/server/llm/schemas";

describe("analysisSchema", () => {
	it("accepts the canonical canned shape", () => {
		expect(() =>
			analysisSchema.parse({
				summary: "Krótkie podsumowanie rozmowy.",
				keyInsights: [],
				decisions: [],
				actionItems: [],
				candidateTags: [],
			}),
		).not.toThrow();
	});

	it("rejects payloads missing required arrays", () => {
		expect(() =>
			analysisSchema.parse({ summary: "tylko summary, bez tablic" }),
		).toThrow();
	});
});

describe("classificationSchema", () => {
	it("accepts a valid {category, projectId} pair", () => {
		const result = classificationSchema.parse({
			category: "praca",
			projectId: "p1",
		});
		expect(result.category).toBe("praca");
		expect(result.projectId).toBe("p1");
	});

	it("rejects category outside the enum", () => {
		expect(() =>
			classificationSchema.parse({
				category: "invalid",
				projectId: "p1",
			}),
		).toThrow();
	});
});

describe("categorySchema", () => {
	it("accepts 'praca' and 'prywatne'", () => {
		expect(categorySchema.parse("praca")).toBe("praca");
		expect(categorySchema.parse("prywatne")).toBe("prywatne");
	});

	it("rejects unknown categories", () => {
		expect(() => categorySchema.parse("foo")).toThrow();
	});
});
