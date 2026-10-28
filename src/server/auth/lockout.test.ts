import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
	checkLockout,
	type LockoutDb,
	recordFailedLogin,
	recordSuccessfulLogin,
} from "./lockout";

type StubRow = {
	failedAttemptsCount: number;
	lastFailureAt: Date | null;
} | null;

function makeStubDb(row: StubRow) {
	const setWhere = {
		where: vi.fn().mockResolvedValue(undefined),
	};
	const updateChain = {
		set: vi.fn(() => setWhere),
	};
	const insertChain = {
		values: vi.fn().mockResolvedValue(undefined),
	};
	const stub = {
		query: {
			authConfig: {
				findFirst: vi.fn().mockResolvedValue(row),
			},
		},
		update: vi.fn(() => updateChain),
		insert: vi.fn(() => insertChain),
	};
	return {
		// Cast: structural narrow matches LockoutDb's Pick<typeof db, 'query'|'update'|'insert'>.
		// The real `db` carries far more surface; LockoutDb is intentionally minimal.
		db: stub as unknown as LockoutDb,
		stub,
		setVals: updateChain.set,
		insertValues: insertChain.values,
	};
}

describe("lockout", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterAll(() => {
		vi.useRealTimers();
	});

	test("no row in authConfig → not locked", async () => {
		const { db } = makeStubDb(null);
		expect(await checkLockout(db, "me")).toEqual({ locked: false });
	});

	test("49 failed attempts (sub-threshold) → not locked", async () => {
		const { db } = makeStubDb({
			failedAttemptsCount: 49,
			lastFailureAt: new Date(),
		});
		expect(await checkLockout(db, "me")).toEqual({ locked: false });
	});

	test("50 failed attempts within window → locked with retryAfterMs", async () => {
		const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
		const { db } = makeStubDb({
			failedAttemptsCount: 50,
			lastFailureAt: tenMinAgo,
		});
		const state = await checkLockout(db, "me");
		expect(state.locked).toBe(true);
		if (state.locked) {
			// ~20 min remaining (30 min duration - 10 min elapsed)
			expect(state.retryAfterMs).toBeGreaterThan(15 * 60 * 1000);
			expect(state.retryAfterMs).toBeLessThan(25 * 60 * 1000);
		}
	});

	test("50 failed attempts past window → auto-unlock + counter reset", async () => {
		const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000);
		const { db, setVals } = makeStubDb({
			failedAttemptsCount: 50,
			lastFailureAt: thirtyOneMinAgo,
		});
		expect(await checkLockout(db, "me")).toEqual({ locked: false });
		expect(setVals).toHaveBeenCalledWith({
			failedAttemptsCount: 0,
			lastFailureAt: null,
		});
	});

	test("recordFailedLogin increments counter when row exists", async () => {
		const { db, setVals } = makeStubDb({
			failedAttemptsCount: 5,
			lastFailureAt: new Date(),
		});
		await recordFailedLogin(db, "me");
		expect(setVals).toHaveBeenCalledTimes(1);
		expect(setVals).toHaveBeenLastCalledWith(
			expect.objectContaining({
				failedAttemptsCount: 6,
				lastFailureAt: expect.any(Date),
			}),
		);
	});

	test("recordSuccessfulLogin resets counter", async () => {
		const { db, setVals } = makeStubDb({
			failedAttemptsCount: 5,
			lastFailureAt: new Date(),
		});
		await recordSuccessfulLogin(db, "me");
		expect(setVals).toHaveBeenCalledWith({
			failedAttemptsCount: 0,
			lastFailureAt: null,
		});
	});
});
