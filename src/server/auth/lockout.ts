import { eq } from "drizzle-orm";

import type { db as Db } from "~/server/db";
import { authConfig } from "~/server/db/schema";

const ACCOUNT_LOCKOUT_THRESHOLD = 50;
const ACCOUNT_LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export type LockoutState =
	| { locked: false }
	| { locked: true; retryAfterMs: number };

// The DB surface lockout needs is small and stable. Defining the type here
// as a structural narrow keeps lockout tests free of a real libsql client —
// the test passes a `vi.fn()`-backed stub matching this shape.
export type LockoutDb = Pick<typeof Db, "query" | "update" | "insert">;

export async function checkLockout(
	db: LockoutDb,
	userId: string,
): Promise<LockoutState> {
	const row = await db.query.authConfig.findFirst({
		where: eq(authConfig.userId, userId),
		columns: { failedAttemptsCount: true, lastFailureAt: true },
	});
	if (!row) return { locked: false };
	if (row.failedAttemptsCount < ACCOUNT_LOCKOUT_THRESHOLD) {
		return { locked: false };
	}
	const lastFailureAt = row.lastFailureAt;
	if (!lastFailureAt) return { locked: false };
	const elapsed = Date.now() - lastFailureAt.getTime();
	if (elapsed < ACCOUNT_LOCKOUT_DURATION_MS) {
		return {
			locked: true,
			retryAfterMs: ACCOUNT_LOCKOUT_DURATION_MS - elapsed,
		};
	}
	// Window passed — auto-unlock with counter reset.
	await db
		.update(authConfig)
		.set({ failedAttemptsCount: 0, lastFailureAt: null })
		.where(eq(authConfig.userId, userId));
	return { locked: false };
}

export async function recordFailedLogin(
	db: LockoutDb,
	userId: string,
): Promise<void> {
	const row = await db.query.authConfig.findFirst({
		where: eq(authConfig.userId, userId),
		columns: { userId: true, failedAttemptsCount: true },
	});
	const now = new Date();
	if (!row) {
		await db.insert(authConfig).values({
			userId,
			passwordHash: null,
			failedAttemptsCount: 1,
			lastFailureAt: now,
		});
		return;
	}
	await db
		.update(authConfig)
		.set({
			failedAttemptsCount: row.failedAttemptsCount + 1,
			lastFailureAt: now,
		})
		.where(eq(authConfig.userId, userId));
}

export async function recordSuccessfulLogin(
	db: LockoutDb,
	userId: string,
): Promise<void> {
	await db
		.update(authConfig)
		.set({ failedAttemptsCount: 0, lastFailureAt: null })
		.where(eq(authConfig.userId, userId));
}
