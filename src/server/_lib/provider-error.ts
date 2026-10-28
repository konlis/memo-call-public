export type ProviderErrorCode =
	| "transport"
	| "rate_limited"
	| "auth"
	| "invalid_response"
	// A graceful model decline (Anthropic `stop_reason:"refusal"`, an HTTP-200, not
	// a hard block). Kept DISTINCT from `invalid_response` (malformed output) so the
	// worker can count refusals separately in logs. NON-retryable on purpose — a
	// refusal is deterministic, so it must NOT be in RETRYABLE_PROVIDER_ERROR_CODES;
	// it falls through the worker catch to the terminal `failed` disposition.
	| "refusal"
	| "unknown";

export const RETRYABLE_PROVIDER_ERROR_CODES: ReadonlySet<ProviderErrorCode> =
	new Set(["transport", "rate_limited"]);

export type ProviderErrorInit = {
	code: ProviderErrorCode;
	message?: string;
	cause?: unknown;
};

export class ProviderError extends Error {
	readonly code: ProviderErrorCode;
	override readonly cause?: unknown;

	constructor(init: ProviderErrorInit) {
		super(init.message ?? `provider error: ${init.code}`);
		this.name = "ProviderError";
		this.code = init.code;
		if (init.cause !== undefined) {
			this.cause = init.cause;
		}
	}
}
