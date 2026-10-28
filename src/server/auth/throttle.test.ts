import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
	_resetThrottleStateForTests,
	checkThrottle,
	clearThrottle,
	recordFailure,
} from "./throttle";

describe("throttle", () => {
	beforeEach(() => {
		_resetThrottleStateForTests();
		vi.useRealTimers();
	});

	afterAll(() => {
		vi.useRealTimers();
	});

	test("first check is allowed", () => {
		expect(checkThrottle("1.2.3.4")).toEqual({ allowed: true });
	});

	test("30 failures trips the throttle", () => {
		for (let i = 0; i < 30; i++) recordFailure("1.2.3.4");
		const decision = checkThrottle("1.2.3.4");
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.retryAfterMs).toBeGreaterThan(0);
		}
	});

	test("29 failures still allow", () => {
		for (let i = 0; i < 29; i++) recordFailure("1.2.3.4");
		expect(checkThrottle("1.2.3.4")).toEqual({ allowed: true });
	});

	test("clearThrottle resets state", () => {
		for (let i = 0; i < 30; i++) recordFailure("1.2.3.4");
		expect(checkThrottle("1.2.3.4").allowed).toBe(false);
		clearThrottle("1.2.3.4");
		expect(checkThrottle("1.2.3.4")).toEqual({ allowed: true });
	});

	test("different IPs are independent", () => {
		for (let i = 0; i < 30; i++) recordFailure("1.2.3.4");
		expect(checkThrottle("1.2.3.4").allowed).toBe(false);
		expect(checkThrottle("5.6.7.8")).toEqual({ allowed: true });
	});

	test("window expiry resets state", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
		for (let i = 0; i < 30; i++) recordFailure("1.2.3.4");
		expect(checkThrottle("1.2.3.4").allowed).toBe(false);
		// Advance 1h + 1ms past the window
		vi.setSystemTime(new Date("2026-06-03T13:00:00.001Z"));
		expect(checkThrottle("1.2.3.4")).toEqual({ allowed: true });
	});
});
