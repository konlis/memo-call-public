import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	_resetIngressLogStateForTests,
	INGRESS_LOG_BUDGET,
	INGRESS_LOG_WINDOW_MS,
	logChallengeIngress,
	logWebhookIngress,
	token,
} from "./ingress-log";

/**
 * The logger writes to stderr via `console.error`, the same channel as
 * `jobs/audit.ts` and `auth/audit.ts`. Capture it and parse back to objects, so
 * the assertions are about the SHAPE that reaches `fly logs` rather than about
 * an internal call signature.
 */
let lines: Record<string, unknown>[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	lines = [];
	_resetIngressLogStateForTests();
	spy = vi.spyOn(console, "error").mockImplementation((raw: unknown) => {
		lines.push(JSON.parse(String(raw)) as Record<string, unknown>);
	});
});

afterEach(() => {
	spy.mockRestore();
	vi.useRealTimers();
	_resetIngressLogStateForTests();
});

describe("token", () => {
	test("passes through the shapes real providers actually send", () => {
		// Zadarma's lowercased event names and Twilio's lifecycle statuses. If
		// this ever fails, the diagnostic value of the log line is gone — every
		// ordinary event would read `(unrecognized)`.
		for (const value of [
			"notify_record",
			"notify_start",
			"notify_out_end",
			"completed",
			"in-progress",
			"absent",
		]) {
			expect(token(value)).toBe(value);
		}
	});

	test("empty is reported as such, not as an absent field", () => {
		// A missing `event` field is a real, diagnosable state (a malformed post,
		// or a provider that changed its field name) — it must be distinguishable
		// from a value we refused to print.
		expect(token("")).toBe("(empty)");
	});

	// THE POINT OF THIS MODULE. Everything logged here comes from a caller who has
	// proven nothing: the ingress is unauthenticated by construction. A value
	// echoed verbatim would let that caller write bytes of their choosing into the
	// only audit trail this project has (Fly's ~7-day window — there is no DB
	// audit table), including forged lines that impersonate `jobs/audit.ts`.
	test("refuses anything outside the safe shape, byte-for-byte", () => {
		for (const hostile of [
			'","event":"job.done","x":"', // JSON break-out / forged audit line
			"notify\nrecord", // newline ⇒ a second log line
			"notify[31mrecord", // ANSI escape
			"NOTIFY_RECORD", // uppercase: real, but not the shape we print
			"notify record", // space
			"a".repeat(41), // over the length cap
			"../../etc/passwd",
		]) {
			expect(token(hostile)).toBe("(unrecognized)");
		}
	});

	test("the cap is on length, and 40 is inside it", () => {
		expect(token("a".repeat(40))).toBe("a".repeat(40));
		expect(token("a".repeat(41))).toBe("(unrecognized)");
	});
});

describe("logWebhookIngress", () => {
	test("emits one line carrying counts and presence, never content", () => {
		logWebhookIngress({
			path: "recording-status",
			kind: "notify_start",
			bodyBytes: 1234,
			signed: true,
			outcome: "ignored",
		});

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			event: "telephony.ingress.webhook",
			path: "recording-status",
			kind: "notify_start",
			bodyBytes: 1234,
			signed: true,
			outcome: "ignored",
		});
		expect(typeof lines[0]?.ts).toBe("number");
	});

	test("sanitizes the caller-controlled kind", () => {
		logWebhookIngress({
			path: "recording-status",
			kind: '","event":"job.done","jobId":"forged',
			bodyBytes: 0,
			signed: false,
			outcome: "ignored",
		});

		// One line, and it does not contain the forged event name anywhere — the
		// serialized form is asserted, not just the parsed field, because escaping
		// alone would still put the attacker's text in the stream.
		expect(lines).toHaveLength(1);
		expect(lines[0]?.kind).toBe("(unrecognized)");
		expect(JSON.stringify(lines[0])).not.toContain("job.done");
	});
});

describe("logChallengeIngress", () => {
	test("reports only whether the provider recognized the handshake", () => {
		logChallengeIngress({ matched: true });
		expect(lines[0]).toMatchObject({
			event: "telephony.ingress.challenge",
			matched: true,
		});
		// The challenge value is caller-controlled AND reflected in the response
		// body; it is deliberately not an argument here, so it cannot be logged by
		// accident. This pins the field set.
		expect(Object.keys(lines[0] ?? {}).sort()).toEqual([
			"event",
			"matched",
			"ts",
		]);
	});
});

describe("budget", () => {
	function flood(n: number): void {
		for (let i = 0; i < n; i += 1) {
			logWebhookIngress({
				path: "recording-status",
				kind: "notify_start",
				bodyBytes: 10,
				signed: false,
				outcome: "ignored",
			});
		}
	}

	// WHY THIS MATTERS MORE THAN IT LOOKS: the auth trail (`auth/audit.ts`) and
	// the job trail (`jobs/audit.ts`) live ONLY in Fly's ~7-day log window. An
	// unbudgeted line-per-request on an unauthenticated endpoint is therefore an
	// eviction primitive against both — not merely log noise.
	test("stops emitting once the window budget is spent", () => {
		vi.useFakeTimers();
		flood(INGRESS_LOG_BUDGET + 50);
		expect(lines).toHaveLength(INGRESS_LOG_BUDGET);
	});

	test("reports what it suppressed when the window rolls", () => {
		vi.useFakeTimers();
		flood(INGRESS_LOG_BUDGET + 7);
		expect(lines).toHaveLength(INGRESS_LOG_BUDGET);

		vi.advanceTimersByTime(INGRESS_LOG_WINDOW_MS);
		lines = [];
		flood(1);

		// Suppression that leaves no trace would recreate the very confusion this
		// module exists to end: a flood and a quiet hour would read identically.
		expect(lines[0]).toMatchObject({
			event: "telephony.ingress.suppressed",
			count: 7,
		});
		expect(lines[1]).toMatchObject({ event: "telephony.ingress.webhook" });
	});

	test("a fresh window logs again at full budget", () => {
		vi.useFakeTimers();
		flood(INGRESS_LOG_BUDGET);
		vi.advanceTimersByTime(INGRESS_LOG_WINDOW_MS);
		lines = [];
		flood(INGRESS_LOG_BUDGET);
		expect(lines).toHaveLength(INGRESS_LOG_BUDGET);
	});

	test("the budget is shared across both entrypoints", () => {
		// One caller must not be able to spend the webhook budget and leave the
		// handshake path uncapped (or vice versa) — the hazard is per-process, not
		// per-endpoint.
		vi.useFakeTimers();
		flood(INGRESS_LOG_BUDGET);
		lines = [];
		logChallengeIngress({ matched: false });
		expect(lines).toHaveLength(0);
	});
});
