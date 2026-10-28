// DIFFERENTIAL test: the plain-ESM port used by the onboarding smoke probe MUST
// agree byte-for-byte with the canonical TypeScript implementation the server
// authenticates with.
//
// This exists because a drifted port cannot be debugged from its symptom. Both
// Zadarma recipes fail as a clean 401, so a probe signing slightly differently
// reports "wrong key / not an EU project" about credentials that are perfectly
// fine — the operator then rotates a good key, twice, before suspecting the
// tool. The same trap the repo already hit with Deepgram (see lessons.md,
// "Cloud-vendor secret traps") and with the Deepgram management-endpoint probe.
//
// Asserting on FIXED VECTORS would not be enough: fixed vectors pin the port,
// but a change to the TypeScript original would sail past them and only the
// server would move. Comparing the two implementations directly is what makes
// "these must never diverge" a mechanically-enforced statement instead of a
// comment.

import { describe, expect, it } from "vitest";

import { signZadarmaRequest as canonical } from "~/server/telephony/zadarma-signature";

import { signZadarmaRequest as ported } from "./zadarma-sign.mjs";

const USER_KEY = "test-user-key";
const SECRET = "test-secret";

// The matrix deliberately includes the two encodings that break naive ports,
// plus the cases the canonical implementation's own tests call out.
const CASES: {
	name: string;
	apiPath: string;
	params: Record<string, string>;
}[] = [
	{ name: "no params", apiPath: "/v1/pbx/internal/", params: {} },
	{
		name: "single param",
		apiPath: "/v1/pbx/internal/100/info/",
		params: { id: "100" },
	},
	{
		name: "params given out of sorted order",
		apiPath: "/v1/request/callback/",
		params: { to: "+48512345678", sip: "100", from: "+48221234567" },
	},
	{
		// Both serializers emit `+` for a space (form-urlencoded), so this case
		// pins agreement rather than a substitution — see the note in
		// `zadarma-signature.ts` about the inert `%20` replace.
		name: "value containing a space",
		apiPath: "/v1/statistics/pbx/",
		params: { comment: "a b c" },
	},
	{
		// `%3A` must stay encoded — the case that breaks "just decode it" ports.
		name: "timestamp with colons",
		apiPath: "/v1/statistics/pbx/",
		params: { start: "2026-09-07 10:00:00", end: "2026-09-07 23:59:59" },
	},
	{
		name: "path without a trailing slash",
		apiPath: "/v1/pbx/internal",
		params: { id: "100" },
	},
	{
		name: "value that already looks percent-encoded",
		apiPath: "/v1/pbx/record/request/",
		params: { call_id: "in_20b67427cf29e305a77f09d12a3976e092787adf%20" },
	},
	{
		name: "non-ascii value",
		apiPath: "/v1/statistics/pbx/",
		params: { comment: "zażółć gęślą jaźń" },
	},
];

describe("zadarma-sign.mjs port vs src/server/telephony/zadarma-signature.ts", () => {
	it.each(CASES)("agrees byte-for-byte: $name", ({ apiPath, params }) => {
		const a = canonical({ apiPath, params, userKey: USER_KEY, secret: SECRET });
		const b = ported({ apiPath, params, userKey: USER_KEY, secret: SECRET });
		expect(b.paramsString).toBe(a.paramsString);
		expect(b.authorization).toBe(a.authorization);
	});

	it("produces a non-trivial signature (guards a both-broken tautology)", () => {
		// If both implementations regressed to returning "" this suite would still
		// be green. Pin the shape so the agreement above means something.
		const { paramsString, authorization } = ported({
			apiPath: "/v1/pbx/internal/",
			params: {},
			userKey: USER_KEY,
			secret: SECRET,
		});
		expect(paramsString).toBe("format=json");
		expect(authorization.startsWith(`${USER_KEY}:`)).toBe(true);
		// base64 of a 40-char hex digest = 56 chars.
		expect(authorization.slice(USER_KEY.length + 1)).toHaveLength(56);
	});

	it("a different secret yields a different signature", () => {
		const base = ported({
			apiPath: "/v1/pbx/internal/",
			params: { id: "100" },
			userKey: USER_KEY,
			secret: SECRET,
		});
		const other = ported({
			apiPath: "/v1/pbx/internal/",
			params: { id: "100" },
			userKey: USER_KEY,
			secret: `${SECRET}-x`,
		});
		expect(other.authorization).not.toBe(base.authorization);
	});
});
