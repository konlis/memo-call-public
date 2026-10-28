import { describe, expect, test, vi } from "vitest";

/**
 * The first test on the route gate's matcher (criterion 3.9 of
 * `telephony-provider-zadarma`).
 *
 * WHY IT NEEDS MOCKS: `proxy.ts` imports `~/server/db`, whose module body opens a
 * libsql connection at import time, and `~/server/auth`, which builds the whole
 * NextAuth config. Neither is exercised here — `config.matcher` is a plain string
 * constant — but both would run on import. `auth()` is stubbed as identity: the
 * real one wraps the handler, and this file asserts nothing about the handler.
 *
 * WHAT THIS PROVES, precisely: that the exclusion list contains the tokens we
 * think it does, anchored the way the matcher's comment says they are — which is
 * the five route tokens only; the static-asset tokens are unanchored prefixes and
 * are pinned as such below. It does NOT prove Next.js
 * compiles the pattern identically — Next runs it through path-to-regexp, this
 * runs it as a bare RegExp — and a matcher can also fail by not being loaded at
 * all (the repo-root-`proxy.ts` trap in CLAUDE.md "Lessons", which only a build's route
 * table shows). Those two remain manual checks; this covers the third failure
 * mode, which is the one that changes with every new route: a token that is
 * missing, misspelled, or silently swallowing its neighbours.
 *
 * A LEFTOVER token (the retired vendor-named prefix surviving next to
 * `api/telephony`) is deliberately NOT asserted here: writing that literal would
 * be the only hit in the change's `grep -rn "api/<vendor>" src scripts`
 * criterion, turning a mechanical zero-stale-references gate into a permanent
 * false positive. The grep already covers it, and covers it better — it sees
 * every file, not only this one.
 */
vi.mock("~/server/db", () => ({ db: {}, client: {} }));
vi.mock("~/server/auth", () => ({
	auth: (handler: unknown) => handler,
}));
vi.mock("~/server/auth/audit", () => ({ logAuthEvent: vi.fn() }));

import { config } from "./proxy";

/** The gate RUNS on a path iff the matcher matches it. */
function isGated(pathname: string): boolean {
	const pattern = config.matcher[0];
	if (!pattern) throw new Error("matcher is empty");
	return new RegExp(`^${pattern}$`).test(pathname);
}

describe("proxy matcher", () => {
	// The whole point of phase 3's rename: one token covers all three handlers
	// under the prefix. A missing exclusion here does not fail loudly — the gate
	// answers the provider with a 307 to /login and capture stops, visible only in
	// the vendor's console.
	test.each([
		"/api/telephony/events",
		"/api/telephony/voice",
		"/api/telephony/recording-status",
	])("%s is EXCLUDED from the gate", (path) => {
		expect(isGated(path)).toBe(false);
	});

	// The `(?:/|$)` anchor, stated as a live assertion rather than a comment. A
	// future admin surface that merely STARTS WITH the token must stay gated —
	// an unanchored alternation would hand it to the internet.
	test.each([
		"/api/telephony-admin",
		"/api/telephonyx",
		"/login-history",
	])("%s is still GATED (prefix is not a free pass)", (path) => {
		expect(isGated(path)).toBe(true);
	});

	test.each([
		"/login",
		"/setup",
		"/api/auth/session",
		"/api/trpc/calls.list",
	])("%s stays excluded (unchanged auth surface)", (path) => {
		expect(isGated(path)).toBe(false);
	});

	// The anchoring asymmetry, pinned as MEASURED rather than as assumed. These
	// three fall OUTSIDE the gate because the static-asset tokens are bare
	// prefixes (see the comment above the matcher). Harmless — none is a route —
	// but a reader who believes "every token is anchored" would predict the
	// opposite, and this is where that belief breaks. Tightening them is a
	// deliberate future choice, and this test is what would flag it as a change.
	test.each([
		"/favicon.ico.txt",
		"/_next/staticfoo",
		"/_next/imagex",
	])("%s is ungated — static-asset tokens are unanchored prefixes", (path) => {
		expect(isGated(path)).toBe(false);
	});

	test.each([
		"/",
		"/call",
		"/conversations/abc123",
	])("%s is gated (the default for everything else)", (path) => {
		expect(isGated(path)).toBe(true);
	});
});
