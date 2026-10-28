import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	encodeZadarmaSignature,
	signZadarmaRequest,
	verifyZadarmaWebhookSignature,
	zadarmaWebhookSignatureString,
} from "~/server/telephony/zadarma-signature";

/**
 * FROZEN BYTE VECTORS.
 *
 * These are not "whatever the code happens to produce" — they were generated
 * with the recipe in `scripts/spike/zadarma-stereo.mjs`, which was itself
 * verified differentially against the official `zadarma-api` library and then
 * confirmed live against Zadarma's API. Recomputing an expectation with the
 * implementation under test would assert nothing; a literal does.
 *
 * ⚠️ THAT REASONING HAS A HOLE, and it cost a day of production capture. It is
 * sound only for a vector whose SOURCE is independent of the code under test.
 * The request vectors below qualify (differentially checked against the vendor
 * library). The WEBHOOK vector did not: it was frozen from our own output, so it
 * pinned our own mistaken raw-digest recipe as if it were the vendor's, and the
 * suite then defended the bug. A literal asserts nothing that its provenance
 * does not already guarantee — record where each vector CAME FROM, not just
 * that it is a literal.
 *
 * The params deliberately exercise both encoding quirks that separate a correct
 * port from a naive one:
 *   - a SPACE inside a value  -> must serialize as `+`, not `%20`
 *   - a COLON inside a value  -> must stay `%3A` (NOT decoded alongside the space)
 */
const VECTOR = {
	userKey: "spike-key",
	secret: "spike-secret",
	apiPath: "/v1/pbx/record/request/",
	params: {
		call_id: "in_abc 123",
		lifetime: "1800",
		start: "2026-09-05 16:36:00",
	},
	paramsString:
		"call_id=in_abc+123&format=json&lifetime=1800&start=2026-09-05+16%3A36%3A00",
	authorization:
		"spike-key:YWQyYjIyMjQ4NzI3YTUzMDBlYzNhNzg4OGNkYzU2ODY4MDZjMzFkMw==",
} as const;

describe("signZadarmaRequest", () => {
	it("reproduces the spike script's vector byte for byte", () => {
		const signed = signZadarmaRequest({
			apiPath: VECTOR.apiPath,
			params: VECTOR.params,
			userKey: VECTOR.userKey,
			secret: VECTOR.secret,
		});
		expect(signed.paramsString).toBe(VECTOR.paramsString);
		expect(signed.authorization).toBe(VECTOR.authorization);
	});

	it("appends format=json and sorts params before signing", () => {
		// Same params, different insertion order — the signature must not move.
		const shuffled = signZadarmaRequest({
			apiPath: VECTOR.apiPath,
			params: {
				start: "2026-09-05 16:36:00",
				call_id: "in_abc 123",
				lifetime: "1800",
			},
			userKey: VECTOR.userKey,
			secret: VECTOR.secret,
		});
		expect(shuffled.authorization).toBe(VECTOR.authorization);
		expect(shuffled.paramsString).toContain("format=json");
	});

	it("signs the path verbatim — the trailing slash is part of the signature", () => {
		const withSlash = signZadarmaRequest({
			apiPath: "/v1/info/balance/",
			params: {},
			userKey: VECTOR.userKey,
			secret: VECTOR.secret,
		});
		const withoutSlash = signZadarmaRequest({
			apiPath: "/v1/info/balance",
			params: {},
			userKey: VECTOR.userKey,
			secret: VECTOR.secret,
		});
		expect(withSlash.authorization).not.toBe(withoutSlash.authorization);
	});

	it("base64s the HEX digest, not the raw one (the asymmetry)", () => {
		const signed = signZadarmaRequest({
			apiPath: VECTOR.apiPath,
			params: VECTOR.params,
			userKey: VECTOR.userKey,
			secret: VECTOR.secret,
		});
		const decoded = Buffer.from(
			signed.authorization.split(":")[1] as string,
			"base64",
		).toString("utf8");
		// 40 lowercase hex chars = a SHA-1 digest rendered as text. If someone
		// "simplifies" this to .digest("base64") the decode yields 20 raw bytes
		// instead, and this assertion is what catches it.
		expect(decoded).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("zadarmaWebhookSignatureString", () => {
	it("concatenates the two NOTIFY_RECORD fields", () => {
		expect(
			zadarmaWebhookSignatureString({
				event: "NOTIFY_RECORD",
				pbx_call_id: "in_pbx_1",
				call_id_with_rec: "rec_9",
			}),
		).toBe("in_pbx_1rec_9");
	});

	it("returns null for an event whose signed fields we do not know", () => {
		expect(
			zadarmaWebhookSignatureString({ event: "NOTIFY_END", pbx_call_id: "x" }),
		).toBeNull();
	});
});

// The property that makes the whole file coherent, and the one nothing checked
// before 2026-09-08: the vendor has ONE `encodeSignature` (lib/Client.php:112)
// used for BOTH the request auth header and webhook verification. Ours must too
// — two encoders are exactly what let the two drift apart.
describe("encodeZadarmaSignature", () => {
	it("base64s the 40-char HEX digest, so the result is 56 chars not 28", () => {
		const out = encodeZadarmaSignature("in_pbx_1rec_9", "spike-secret");
		expect(out).toHaveLength(56);
		expect(Buffer.from(out, "base64").toString("utf8")).toMatch(
			/^[0-9a-f]{40}$/,
		);
	});

	it("is the encoder BOTH directions use", () => {
		// Request path: the signature after the `key:` prefix must be exactly what
		// the shared encoder produces for the same signed string.
		const { paramsString, authorization } = signZadarmaRequest({
			apiPath: "/v1/pbx/record/request/",
			params: { call_id: "abc" },
			userKey: "K",
			secret: "spike-secret",
		});
		const md5 = createHash("md5").update(paramsString).digest("hex");
		expect(authorization).toBe(
			`K:${encodeZadarmaSignature("/v1/pbx/record/request/" + paramsString + md5, "spike-secret")}`,
		);

		// Webhook path: a signature produced by the same encoder verifies.
		expect(
			verifyZadarmaWebhookSignature({
				signature: encodeZadarmaSignature("in_pbx_1rec_9", "spike-secret"),
				params: {
					event: "NOTIFY_RECORD",
					pbx_call_id: "in_pbx_1",
					call_id_with_rec: "rec_9",
				},
				secret: "spike-secret",
			}),
		).toBe(true);
	});
});

describe("verifyZadarmaWebhookSignature", () => {
	const params = {
		event: "NOTIFY_RECORD",
		pbx_call_id: "in_pbx_1",
		call_id_with_rec: "rec_9",
	};
	// Frozen vector: base64 of the HEX hmac-sha1 digest over "in_pbx_1rec_9" —
	// i.e. `base64_encode(hash_hmac('sha1', $s, $secret))` in PHP, where
	// `hash_hmac` defaults to hex output. 56 chars, not 28.
	//
	// ⚠️ THIS CONSTANT USED TO HOLD THE RAW-DIGEST VALUE
	// ("QOkx2sWxgI2O2sHQOySBG1LMALo="), frozen from our own implementation rather
	// than from the vendor. A vector captured from the code it is testing pins
	// whatever that code does, correct or not — this one pinned a bug that 403'd
	// every real `NOTIFY_RECORD` for a day (OPT-232). Recomputed here from the
	// vendor's published recipe (`zadarma/user-api-v1`, `lib/Client.php:112`).
	const validSignature = Buffer.from(
		createHmac("sha1", "spike-secret").update("in_pbx_1rec_9").digest("hex"),
	).toString("base64");

	it("accepts a signature built with the vendor's hex-then-base64 recipe", () => {
		expect(
			verifyZadarmaWebhookSignature({
				signature: validSignature,
				params,
				secret: "spike-secret",
			}),
		).toBe(true);
	});

	// REGRESSION: the official SDK's `if (signature && signature !== expected)`
	// skips the comparison when the signature is absent or empty and reports the
	// event as verified. The signature is the only authorization this endpoint
	// has, so both cases must REFUSE.
	it.each([
		"",
		undefined as unknown as string,
	])("refuses a missing or empty signature (SDK gap)", (signature) => {
		expect(
			verifyZadarmaWebhookSignature({
				signature,
				params,
				secret: "spike-secret",
			}),
		).toBe(false);
	});

	// REGRESSION: createHmac("sha1", "") does not throw, so an empty secret would
	// otherwise verify a MAC anyone can compute. ZADARMA_SECRET is `.optional()`
	// in src/env.js, which makes `?? ""` a reachable mistake in Phase 2.
	it("refuses an empty secret instead of verifying an attacker-computable MAC", () => {
		const forgeable = createHmac("sha1", "")
			.update("in_pbx_1rec_9")
			.digest("base64");
		expect(
			verifyZadarmaWebhookSignature({
				signature: forgeable,
				params,
				secret: "",
			}),
		).toBe(false);
	});

	// The exact inversion of what this test used to assert. Both directions of
	// Zadarma's HMAC share ONE encoding; the belief that the webhook path used a
	// RAW digest is what produced the outage, and this test previously enforced
	// it. Keeping the case (inverted) is the regression guard.
	it("refuses a signature built with the RAW-digest recipe", () => {
		const wrongRecipe = createHmac("sha1", "spike-secret")
			.update("in_pbx_1rec_9")
			.digest("base64");
		expect(wrongRecipe).not.toBe(validSignature);
		expect(
			verifyZadarmaWebhookSignature({
				signature: wrongRecipe,
				params,
				secret: "spike-secret",
			}),
		).toBe(false);
	});

	it("refuses a valid signature computed with a different secret", () => {
		expect(
			verifyZadarmaWebhookSignature({
				signature: validSignature,
				params,
				secret: "other-secret",
			}),
		).toBe(false);
	});

	it("refuses when the signed fields were tampered with", () => {
		expect(
			verifyZadarmaWebhookSignature({
				signature: validSignature,
				params: { ...params, call_id_with_rec: "rec_10" },
				secret: "spike-secret",
			}),
		).toBe(false);
	});

	it("refuses an event whose signed field set is unknown", () => {
		expect(
			verifyZadarmaWebhookSignature({
				signature: validSignature,
				params: { event: "NOTIFY_END", pbx_call_id: "in_pbx_1" },
				secret: "spike-secret",
			}),
		).toBe(false);
	});

	it("refuses a signature of a different length without throwing", () => {
		// timingSafeEqual throws on length mismatch — safeEqual must absorb that.
		expect(() =>
			verifyZadarmaWebhookSignature({
				signature: "short",
				params,
				secret: "spike-secret",
			}),
		).not.toThrow();
		expect(
			verifyZadarmaWebhookSignature({
				signature: "short",
				params,
				secret: "spike-secret",
			}),
		).toBe(false);
	});
});
