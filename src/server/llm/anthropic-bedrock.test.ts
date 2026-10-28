import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderErrorCode } from "~/server/_lib/provider-error";
import { ProviderError } from "~/server/_lib/provider-error";
import { type Analysis, analysisSchema } from "~/server/llm/schemas";

// The provider reads `env.AWS_*` through `~/env` at *construction* (frozen-once by
// @t3-oss/env-nextjs, so vi.stubEnv would be invisible). Mirror deepgram.test.ts:
// a hoisted mutable `envMock` the provider reads at construction time — mutate it
// before `new AnthropicBedrockLlmProvider()` for per-test control (present vs
// missing creds). Mocking `~/env` also means this file needs no DATABASE_URL.
const { envMock } = vi.hoisted(() => ({
	envMock: {
		AWS_ACCESS_KEY_ID: "AKIA-test" as string | undefined,
		AWS_SECRET_ACCESS_KEY: "secret-test" as string | undefined,
		AWS_REGION: "eu-central-1" as string | undefined,
		BEDROCK_MODEL_ID: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" as
			| string
			| undefined,
	},
}));
vi.mock("~/env", () => ({ env: envMock }));

// Mock ONLY the Bedrock client (controllable `messages.create`). `@anthropic-ai/sdk`
// stays real so the provider's `instanceof APIError` map sees the same classes the
// test throws.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({
	AnthropicBedrock: class {
		messages = { create: createMock };
	},
}));

import { AnthropicBedrockLlmProvider } from "~/server/llm/anthropic-bedrock";

const validAnalysis: Analysis = {
	summary: "Krótka rozmowa o terminie demo i budżecie.",
	keyInsights: ["Budżet potwierdzony."],
	decisions: ["Demo w piątek."],
	actionItems: ["Wysłać podsumowanie."],
	candidateTags: ["demo", "budzet"],
};

/** A Bedrock `Message`-shaped success carrying a tool_use block. */
function toolUseResponse(input: unknown) {
	return {
		stop_reason: "tool_use",
		content: [{ type: "tool_use", id: "tu_1", name: "emit_result", input }],
	};
}

beforeEach(() => {
	envMock.AWS_ACCESS_KEY_ID = "AKIA-test";
	envMock.AWS_SECRET_ACCESS_KEY = "secret-test";
	envMock.AWS_REGION = "eu-central-1";
	envMock.BEDROCK_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
	createMock.mockReset();
});

describe("AnthropicBedrockLlmProvider", () => {
	describe("construction", () => {
		it.each([
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_REGION",
			"BEDROCK_MODEL_ID",
		] as const)("throws auth at construction when %s is missing", (missing) => {
			envMock[missing] = undefined;
			try {
				new AnthropicBedrockLlmProvider();
				expect.unreachable("constructor should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ProviderError);
				expect((err as ProviderError).code).toBe("auth");
			}
		});
	});

	describe("generateStructured", () => {
		it("returns the safeParse'd value on a tool_use response", async () => {
			createMock.mockResolvedValue(toolUseResponse(validAnalysis));
			const provider = new AnthropicBedrockLlmProvider();

			const result = await provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			expect(result).toEqual(validAnalysis);
			expect(createMock).toHaveBeenCalledTimes(1);
		});

		it("forces non-strict tool_choice and passes a derived input_schema (no strict:true)", async () => {
			createMock.mockResolvedValue(toolUseResponse(validAnalysis));
			const provider = new AnthropicBedrockLlmProvider();

			await provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			const args = createMock.mock.calls[0]?.[0];
			expect(args.tool_choice).toEqual({ type: "tool", name: "emit_result" });
			expect(args.tools).toHaveLength(1);
			expect(args.tools[0].name).toBe("emit_result");
			expect(args.tools[0].input_schema).toMatchObject({ type: "object" });
			// NON-strict: neither the tool nor the request carries `strict`.
			expect(args.tools[0].strict).toBeUndefined();
			expect(args.tools[0].input_schema.$schema).toBeUndefined();
		});

		it("throws ProviderError code 'refusal' (non-retryable) on stop_reason=refusal", async () => {
			createMock.mockResolvedValue({ stop_reason: "refusal", content: [] });
			const provider = new AnthropicBedrockLlmProvider();

			const promise = provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code: "refusal" });
			// Refusal is deterministic — NOT retried.
			expect(createMock).toHaveBeenCalledTimes(1);
		});

		it("retries a schema-shape flake once, then returns the valid value", async () => {
			// Attempt 1: Haiku's `<item>`-XML array flake (candidateTags a string).
			const flaked = { ...validAnalysis, candidateTags: "<item>demo</item>" };
			createMock
				.mockResolvedValueOnce(toolUseResponse(flaked))
				.mockResolvedValueOnce(toolUseResponse(validAnalysis));
			const provider = new AnthropicBedrockLlmProvider();

			const result = await provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			expect(result).toEqual(validAnalysis);
			expect(createMock).toHaveBeenCalledTimes(2);
			// The retry carries the corrective hint in the system prompt.
			expect(createMock.mock.calls[1]?.[0]?.system).toMatch(/walidacj/i);
		});

		it("throws 'invalid_response' after exhausting retries on a persistent shape flake", async () => {
			createMock.mockResolvedValue(
				toolUseResponse({ ...validAnalysis, candidateTags: "<item>x</item>" }),
			);
			const provider = new AnthropicBedrockLlmProvider();

			const promise = provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
			expect(createMock).toHaveBeenCalledTimes(2);
		});

		it("throws 'invalid_response' on a 200 with no tool_use block (e.g. max_tokens)", async () => {
			createMock.mockResolvedValue({ stop_reason: "max_tokens", content: [] });
			const provider = new AnthropicBedrockLlmProvider();

			const promise = provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
		});

		// SDK APIError subclasses (by HTTP status) → ProviderError code. A throw is
		// terminal (the SDK already exhausted maxRetries), so it is NOT retried here.
		it.each<[number, ProviderErrorCode]>([
			[401, "auth"],
			[403, "auth"],
			[429, "rate_limited"],
			[400, "invalid_response"],
			[500, "transport"],
		])("maps APIError status %i → ProviderError code '%s'", async (status, code) => {
			createMock.mockRejectedValue(
				new APIError(status, undefined, `http ${status}`, new Headers()),
			);
			const provider = new AnthropicBedrockLlmProvider();

			const promise = provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			await expect(promise).rejects.toBeInstanceOf(ProviderError);
			await expect(promise).rejects.toMatchObject({ code });
			expect(createMock).toHaveBeenCalledTimes(1);
		});

		it("maps an APIConnectionError (no status) → 'transport'", async () => {
			createMock.mockRejectedValue(
				new APIConnectionError({ message: "socket reset" }),
			);
			const provider = new AnthropicBedrockLlmProvider();

			const promise = provider.generateStructured({
				prompt: "p",
				schema: analysisSchema,
			});

			await expect(promise).rejects.toMatchObject({ code: "transport" });
		});
	});
});
