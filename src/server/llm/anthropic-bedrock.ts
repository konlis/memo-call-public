import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { APIError } from "@anthropic-ai/sdk";
import type { ZodSchema } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { env } from "~/env";
import { ProviderError } from "~/server/_lib/provider-error";
import type { LlmProvider } from "~/server/llm/types";

const TOOL_NAME = "emit_result";
const MAX_TOKENS = 4096;

// One generic system prompt for every schema (the provider is schema-agnostic; the
// business prompt arrives as the user message from analyze.ts / classify.ts). The
// array-format clause is load-bearing: the Phase 1 spike caught Haiku serializing
// an array field as `<item>…</item>` pseudo-XML instead of a JSON array (spike.md),
// which `safeParse` then rejected. Spelling out "arrays as JSON arrays" + the
// bounded retry below is the agreed fix.
const SYSTEM_PROMPT = [
	"ZAWSZE odpowiadaj po polsku.",
	`Odpowiadaj WYŁĄCZNIE przez wywołanie narzędzia ${TOOL_NAME} zgodnie z jego schematem.`,
	'Pola typu tablica MUSZĄ być tablicami JSON (np. ["a","b"]) — NIGDY tekstem, NIGDY XML, NIGDY znacznikami <item>.',
].join("\n");

const RETRY_HINT =
	"\nUWAGA: poprzednia odpowiedź nie przeszła walidacji schematu. Zwróć poprawny JSON; tablice jako tablice JSON.";

// Re-validate at most twice. Attempt 1 is the honest call; attempt 2 retries ONLY
// a schema-shape flake (the spike's `<item>`-XML array class) with a corrective
// hint before giving up with `invalid_response`. A `refusal` is NOT retried (it is
// deterministic) — it throws immediately. Transport retries (FR-006) are the SDK's
// `maxRetries:5`, a layer below this.
const MAX_STRUCTURED_ATTEMPTS = 2;

// Minimal structural view of the non-streaming `messages.create` result — only the
// fields we read. We don't pass `stream:true`, but the SDK's create() overloads
// type the result as `Message | Stream`; reading through this local type keeps the
// provider decoupled from the SDK's exact type subpaths (which shift across versions).
type BedrockMessageView = {
	stop_reason: string | null;
	content: Array<{ type: string; input?: unknown }>;
};

/**
 * Real LLM provider: Anthropic Claude (Haiku 4.5) on Amazon Bedrock, EU inference
 * profile. Structured output is **non-strict forced tool-use**: one `emit_result`
 * tool whose `input_schema` is derived from the supplied Zod schema via
 * `zod-to-json-schema` (NOT a hand-mirror — review F3), `tool_choice` forced to it.
 * Anthropic non-strict tool schemas accept-but-ignore `max/min/maxItems` (no 400,
 * unlike Azure strict json_schema), so the full schema passes as-is and
 * `schema.safeParse(tool_use.input)` enforces the bounds.
 *
 * EU residency + no-training are product constraints (CLAUDE.md): the model is the
 * `eu.` inference profile (EU-only routing) and Bedrock does not train on inputs by
 * default. All failures funnel through the shared `ProviderError` discriminator so
 * the worker's retry / dead-letter switch behaves identically to the mock — with
 * `refusal` as a dedicated, non-retryable code.
 */
export class AnthropicBedrockLlmProvider implements LlmProvider {
	private readonly client: AnthropicBedrock;
	private readonly model: string;

	constructor() {
		const accessKey = env.AWS_ACCESS_KEY_ID;
		const secretKey = env.AWS_SECRET_ACCESS_KEY;
		const region = env.AWS_REGION;
		const model = env.BEDROCK_MODEL_ID;
		// Loud failure at construction, mirroring the Deepgram/Twilio real-branch
		// pattern — never a silent fallback to mock. Keeps `next build` green with a
		// placeholder env (these four are `.optional()` in env.js).
		if (!accessKey || !secretKey || !region || !model) {
			throw new ProviderError({
				code: "auth",
				message:
					"AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION and BEDROCK_MODEL_ID are all required when LLM_PROVIDER=anthropic-bedrock (set them as Fly secrets)",
			});
		}
		this.model = model;
		this.client = new AnthropicBedrock({
			awsAccessKey: accessKey,
			awsSecretKey: secretKey,
			awsRegion: region,
			maxRetries: 5, // FR-006 transport retry (exp backoff on 408/409/429/5xx/conn)
		});
	}

	async generateStructured<T>(input: {
		prompt: string;
		schema: ZodSchema<T>;
	}): Promise<T> {
		const inputSchema = toToolInputSchema(input.schema);
		const tool = {
			name: TOOL_NAME,
			description: "Zwróć ustrukturyzowany wynik zgodny ze schematem.",
			input_schema: inputSchema,
		};

		let lastDetail = "no attempt completed";
		for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
			let res: BedrockMessageView;
			try {
				res = (await this.client.messages.create({
					model: this.model,
					max_tokens: MAX_TOKENS,
					system: attempt === 1 ? SYSTEM_PROMPT : SYSTEM_PROMPT + RETRY_HINT,
					tools: [tool], // NON-STRICT (no strict:true) — accepts max/min, no 400
					tool_choice: { type: "tool", name: TOOL_NAME },
					messages: [{ role: "user", content: input.prompt }],
				})) as unknown as BedrockMessageView;
			} catch (cause) {
				// The SDK already exhausted `maxRetries` transport retries before
				// throwing; map the terminal error to a ProviderError code.
				throw mapSdkError(cause);
			}

			// A graceful decline — non-retryable, surfaced as its own code. Throw
			// immediately (do NOT spend the retry on a deterministic refusal).
			if (res.stop_reason === "refusal") {
				throw new ProviderError({
					code: "refusal",
					message: "Claude returned stop_reason=refusal",
				});
			}

			const toolUse = res.content.find((block) => block.type === "tool_use");
			if (res.stop_reason === "tool_use" && toolUse) {
				const parsed = input.schema.safeParse(toolUse.input);
				if (parsed.success) return parsed.data;
				// Schema-shape flake (e.g. the spike's `<item>`-XML array). Retry with
				// a corrective hint; if attempts run out, fall through to invalid_response.
				lastDetail = `safeParse failed: ${parsed.error.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; ")}`;
				continue;
			}

			// max_tokens (truncated) or a 200 with no tool_use block — malformed, not
			// a refusal. Retry once, then give up as invalid_response.
			lastDetail = `unexpected stop_reason=${res.stop_reason ?? "null"} (tool_use block ${toolUse ? "present" : "absent"})`;
		}

		throw new ProviderError({
			code: "invalid_response",
			message: `Claude did not return a schema-valid tool_use after ${MAX_STRUCTURED_ATTEMPTS} attempt(s): ${lastDetail}`,
		});
	}
}

/**
 * Derive the tool `input_schema` from the real Zod schema (review F3 — never a
 * hand-mirror). `zod-to-json-schema` with the OpenAPI-3 target emits a clean
 * JSON-Schema object (no `$schema` wrapper); we strip `$schema` defensively in case
 * a future target reintroduces it. Passed NON-strict, so the `max/min` bounds ride
 * along and are enforced by our own `safeParse`, not by Bedrock.
 */
function toToolInputSchema(schema: ZodSchema<unknown>): {
	type: "object";
	[k: string]: unknown;
} {
	const json = zodToJsonSchema(schema, { target: "openApi3" }) as Record<
		string,
		unknown
	>;
	const { $schema: _drop, ...rest } = json;
	// The Anthropic tool `input_schema` requires a literal `type: "object"`. Both our
	// consuming schemas (analysis/classification) are `z.object`, so this is always
	// true at runtime; the assignment just narrows the type for the SDK.
	return { ...rest, type: "object" };
}

/**
 * Map a thrown SDK error to the shared `ProviderError` discriminator. Uses
 * `instanceof APIError` + the HTTP `.status` (robust; bedrock-sdk dedupes to one
 * `@anthropic-ai/sdk` copy so the instanceof holds). The region/model-enablement
 * trap (Bedrock's analogue of Deepgram's region-key 401) surfaces as 403
 * `AccessDeniedException` / 400 `ValidationException` → `auth` / `invalid_response`,
 * dead-lettering loudly rather than silently.
 */
function mapSdkError(cause: unknown): ProviderError {
	if (cause instanceof ProviderError) return cause;
	if (cause instanceof APIError) {
		const status = cause.status;
		// APIConnectionError carries no status — a transport-level failure.
		if (status === undefined) {
			return new ProviderError({
				code: "transport",
				message: "Bedrock connection error",
				cause,
			});
		}
		if (status === 401 || status === 403) {
			return new ProviderError({
				code: "auth",
				message: `Bedrock auth/permission denied (${status}) — check IAM bedrock:InvokeModel on the EU profile + foundation-model ARNs and Haiku 4.5 enablement in the region`,
				cause,
			});
		}
		if (status === 429) {
			return new ProviderError({
				code: "rate_limited",
				message: "Bedrock rate limited (429)",
				cause,
			});
		}
		if (status === 400) {
			return new ProviderError({
				code: "invalid_response",
				message: "Bedrock rejected the request (400 ValidationException)",
				cause,
			});
		}
		if (status >= 500) {
			return new ProviderError({
				code: "transport",
				message: `Bedrock server error (${status})`,
				cause,
			});
		}
		return new ProviderError({
			code: "unknown",
			message: `Bedrock API error (${status})`,
			cause,
		});
	}
	return new ProviderError({
		code: "unknown",
		message: "unexpected error calling Bedrock",
		cause,
	});
}
