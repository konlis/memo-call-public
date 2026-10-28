// In-process per-IP throttle. Map state lives at module level — lost on
// Machine restart (intentional, see plan F-03 Round 3 decision). The persistent
// second axis is the DB-backed account-level lockout in ./lockout.ts.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PER_IP_LIMIT = 30;

type ThrottleEntry = { count: number; windowStartAt: number };

const throttle = new Map<string, ThrottleEntry>();

export type ThrottleDecision =
	| { allowed: true }
	| { allowed: false; retryAfterMs: number };

export function checkThrottle(ip: string): ThrottleDecision {
	const now = Date.now();
	const entry = throttle.get(ip);
	if (!entry) return { allowed: true };
	if (now - entry.windowStartAt >= WINDOW_MS) {
		throttle.delete(ip);
		return { allowed: true };
	}
	if (entry.count >= PER_IP_LIMIT) {
		return {
			allowed: false,
			retryAfterMs: WINDOW_MS - (now - entry.windowStartAt),
		};
	}
	return { allowed: true };
}

export function recordFailure(ip: string): void {
	const now = Date.now();
	const entry = throttle.get(ip);
	if (!entry || now - entry.windowStartAt >= WINDOW_MS) {
		throttle.set(ip, { count: 1, windowStartAt: now });
		return;
	}
	entry.count += 1;
}

export function clearThrottle(ip: string): void {
	throttle.delete(ip);
}

// Test-only seam: name-prefixed with `_` to mark intent.
export function _resetThrottleStateForTests(): void {
	throttle.clear();
}
