import { describe, expect, it } from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";

describe("ProviderError", () => {
	it("is both an Error and a ProviderError, carrying the supplied code", () => {
		const err = new ProviderError({ code: "transport" });
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.code).toBe("transport");
	});

	it("uses a sensible default message when none is supplied", () => {
		const err = new ProviderError({ code: "rate_limited" });
		expect(err.message).toBe("provider error: rate_limited");
	});

	it("preserves an explicitly supplied message", () => {
		const err = new ProviderError({
			code: "auth",
			message: "missing service-account token",
		});
		expect(err.message).toBe("missing service-account token");
	});

	it("preserves a supplied cause", () => {
		const original = new Error("upstream socket reset");
		const err = new ProviderError({
			code: "transport",
			message: "fetch failed",
			cause: original,
		});
		expect(err.cause).toBe(original);
	});
});
