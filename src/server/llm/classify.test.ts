import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import {
	type ClassifyInput,
	classify,
	type Project,
} from "~/server/llm/classify";
import type { Classification } from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";

const projects: Project[] = [
	{ id: "p1", name: "Klient A", category: "praca" },
	{ id: "p2", name: "Rodzina", category: "prywatne" },
];

const baseInput: ClassifyInput = {
	transcript: "Rozmawiałem z klientem A o terminie demo.",
	projects,
};

function classification(
	category: "praca" | "prywatne",
	projectId: string,
): Classification {
	return { category, projectId };
}

// Non-generic stub signature: vi.fn cannot preserve the T-binding of
// LlmProvider['generateStructured']<T>, so we type the stub as a plain
// (input) => Promise<Classification> and adapt to the generic interface
// via a single isolated cast at the provider boundary.
type StubFn = (input: {
	prompt: string;
	schema: unknown;
}) => Promise<Classification>;

function asProvider(stub: ReturnType<typeof vi.fn<StubFn>>): LlmProvider {
	return {
		generateStructured: stub as unknown as LlmProvider["generateStructured"],
	};
}

describe("classify (FR-005 constraint-respecting retry-with-feedback)", () => {
	it("returns 'classified' on the first attempt when the provider responds with a valid classification", async () => {
		const stub = vi.fn<StubFn>();
		stub.mockResolvedValue(classification("praca", "p1"));

		const result = await classify(baseInput, { provider: asProvider(stub) });

		expect(result).toEqual({
			status: "classified",
			classification: classification("praca", "p1"),
		});
		expect(stub).toHaveBeenCalledTimes(1);
	});

	it("returns 'no_auto_assignment' after 3 attempts when the constraint is violated every call", async () => {
		const stub = vi.fn<StubFn>();
		// p2 belongs to prywatne; pairing it with praca violates the constraint.
		stub.mockResolvedValue(classification("praca", "p2"));

		const result = await classify(baseInput, { provider: asProvider(stub) });

		expect(result).toEqual({ status: "no_auto_assignment", attempts: 3 });
		expect(stub).toHaveBeenCalledTimes(3);
	});

	it("classifies on mid-retry recovery when the provider returns a valid response within 3 attempts", async () => {
		const stub = vi.fn<StubFn>();
		stub
			.mockResolvedValueOnce(classification("praca", "p2"))
			.mockResolvedValueOnce(classification("praca", "p2"))
			.mockResolvedValueOnce(classification("prywatne", "p2"));

		const result = await classify(baseInput, { provider: asProvider(stub) });

		expect(result).toEqual({
			status: "classified",
			classification: classification("prywatne", "p2"),
		});
		expect(stub).toHaveBeenCalledTimes(3);
	});

	it("includes feedback about the prior violation in retry prompts", async () => {
		const stub = vi.fn<StubFn>();
		stub
			.mockResolvedValueOnce(classification("praca", "p2"))
			.mockResolvedValueOnce(classification("praca", "p2"))
			.mockResolvedValueOnce(classification("prywatne", "p2"));

		await classify(baseInput, { provider: asProvider(stub) });

		expect(stub).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				prompt: expect.stringContaining("p2"),
			}),
		);

		const secondCallPrompt = stub.mock.calls[1]?.[0]?.prompt;
		expect(secondCallPrompt).toMatch(/praca/);
		expect(secondCallPrompt?.toLowerCase()).toMatch(/poprzedni/);

		const thirdCallPrompt = stub.mock.calls[2]?.[0]?.prompt;
		expect(thirdCallPrompt).toMatch(/p2/);
		expect(thirdCallPrompt?.toLowerCase()).toMatch(/poprzedni/);
	});

	it("propagates a ProviderError from the provider without catching it (FR-006 boundary)", async () => {
		const stub = vi.fn<StubFn>();
		stub.mockRejectedValue(
			new ProviderError({
				code: "transport",
				message: "upstream socket reset",
			}),
		);

		const promise = classify(baseInput, { provider: asProvider(stub) });

		await expect(promise).rejects.toBeInstanceOf(ProviderError);
		await expect(promise).rejects.toMatchObject({ code: "transport" });
		expect(stub).toHaveBeenCalledTimes(1);
	});
});

describe("classify input — the counterparty cannot reach the prompt (FR-025, A-5)", () => {
	it("ClassifyInput has exactly the transcript and the projects — no number, no hint", () => {
		// Type-level twin of the `AnalyzeInput` assertion in analyze.test.ts;
		// see the note there. Checked by `tsc --noEmit`, not at runtime.
		expectTypeOf<keyof ClassifyInput>().toEqualTypeOf<
			"transcript" | "projects"
		>();
	});
});
