import { eq } from "drizzle-orm";
import { z } from "zod";
import { safeErrorMessage } from "~/server/_lib/redact";

import { db as defaultDb } from "~/server/db";
import { authConfig } from "~/server/db/schema";
import { logAuthEvent } from "./audit";
import {
	checkLockout,
	type LockoutDb,
	recordFailedLogin,
	recordSuccessfulLogin,
} from "./lockout";
import { verifyPassword } from "./password";
import { checkThrottle, clearThrottle, recordFailure } from "./throttle";

const credentialsSchema = z.object({ password: z.string().min(1) });

function resolveIp(request: Request): string {
	const flyIp = request.headers.get("fly-client-ip");
	if (flyIp) return flyIp;
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}
	return "unknown";
}

// Auth.js v5 Credentials authorize contract: returns User | null. Never throws —
// thrown errors have undefined semantics across v5 minors. The cookie-side
// message is intentionally generic regardless of failure mode (info-leak-safe);
// the audit log is where we record the precise reason.
//
// `opts.db` defaults to the cached singleton; tests pass a structural-narrow
// stub matching `LockoutDb`. Mirrors F-02's classify(input, opts) DI pattern
// and stays consistent with lockout.ts's exported LockoutDb narrow.
export async function credentialsAuthorize(
	credentials: Partial<Record<string, unknown>> | undefined,
	request: Request,
	opts?: { db?: LockoutDb },
): Promise<{ id: string } | null> {
	const db = opts?.db ?? defaultDb;
	const ip = resolveIp(request);

	const parsed = credentialsSchema.safeParse(credentials);
	if (!parsed.success) {
		logAuthEvent("login_failed_wrong_password", { ip });
		return null;
	}

	const throttleDecision = checkThrottle(ip);
	if (!throttleDecision.allowed) {
		logAuthEvent("login_failed_throttled", {
			ip,
			retryAfterMs: throttleDecision.retryAfterMs,
		});
		return null;
	}

	const lockoutState = await checkLockout(db, "me");
	if (lockoutState.locked) {
		logAuthEvent("login_failed_locked", {
			ip,
			userId: "me",
			retryAfterMs: lockoutState.retryAfterMs,
		});
		return null;
	}

	const row = await db.query.authConfig.findFirst({
		where: eq(authConfig.userId, "me"),
		columns: { passwordHash: true, failedAttemptsCount: true },
	});
	if (!row?.passwordHash) {
		recordFailure(ip);
		logAuthEvent("login_failed_no_config", { ip });
		return null;
	}

	const valid = await verifyPassword(parsed.data.password, row.passwordHash);
	if (!valid) {
		// Audit-first: emit BEFORE the DB write so a downstream throw can't drop
		// the trail. Per plan F7 fix.
		logAuthEvent("login_failed_wrong_password", {
			ip,
			attemptCount: row.failedAttemptsCount + 1,
		});
		recordFailure(ip);
		await recordFailedLogin(db, "me").catch((err) => {
			logAuthEvent("login_failed_db_write_error", {
				ip,
				error: safeErrorMessage(err),
			});
		});
		return null;
	}

	logAuthEvent("login_success", { ip, userId: "me" });
	clearThrottle(ip);
	await recordSuccessfulLogin(db, "me").catch((err) => {
		// Best-effort: success audit already landed; surface the DB error.
		logAuthEvent("login_failed_db_write_error", {
			ip,
			userId: "me",
			error: safeErrorMessage(err),
		});
	});
	return { id: "me" };
}
