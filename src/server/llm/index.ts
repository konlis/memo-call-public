import { env } from "~/env";
import { AnthropicBedrockLlmProvider } from "~/server/llm/anthropic-bedrock";
import { MockLlmProvider } from "~/server/llm/mock";
import type { LlmProvider } from "~/server/llm/types";

function createLlm(): LlmProvider {
	switch (env.LLM_PROVIDER) {
		case "mock":
			return new MockLlmProvider();
		case "anthropic-bedrock":
			return new AnthropicBedrockLlmProvider();
	}
}

// Cache the singleton on globalThis in non-production so HMR reloads don't re-run
// the (now real) provider constructor — mirrors the db/index.ts + stt/index.ts
// pattern. The Bedrock constructor validates the four AWS vars, so
// `anthropic-bedrock` without them throws `auth` at module load (loud fail, never a
// mock fallback). Mocks are stateless, so caching is just consistency, not need.
const globalForLlm = globalThis as unknown as {
	llm: LlmProvider | undefined;
};

export const llm: LlmProvider = globalForLlm.llm ?? createLlm();
if (env.NODE_ENV !== "production") globalForLlm.llm = llm;

export {
	type Analysis,
	analysisSchema,
	type Category,
	type Classification,
	categorySchema,
	classificationSchema,
} from "~/server/llm/schemas";
export type { LlmProvider } from "~/server/llm/types";
