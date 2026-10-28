import { TRPCError } from "@trpc/server";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { logAuthEvent } from "~/server/auth/audit";
import { hashPassword } from "~/server/auth/password";
// Import the rule from the no-deps module (not from password.ts) so the
// no-bcryptjs guarantee stays local to this server file's intent.
import { PASSWORD_VALIDATION_SCHEMA } from "~/server/auth/password-rules";
import { authConfig } from "~/server/db/schema";

// publicProcedure (NOT protectedProcedure): the user is by definition
// unauthenticated before setting their first password. The mutation guards
// re-runs itself via the password_hash check below.
export const setupRouter = createTRPCRouter({
	setInitialPassword: publicProcedure
		.input(z.object({ password: PASSWORD_VALIDATION_SCHEMA }))
		.mutation(async ({ ctx, input }) => {
			// Refuse to overwrite an existing password — in-app rotation is a PRD
			// Non-Goal (rotation = SSH admin reset). The proxy's /setup 404 is the
			// UX-side belt; this is the server-side braces.
			const existing = await ctx.db.query.authConfig.findFirst({
				where: eq(authConfig.userId, ctx.userId),
			});
			if (existing?.passwordHash) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Password already set. Use SSH admin reset to rotate.",
				});
			}

			const passwordHash = await hashPassword(input.password);
			// `setWhere: password_hash IS NULL` makes the guard ATOMIC: on conflict
			// (a row already exists — e.g. a pre-setup failed login created one with
			// a null hash), the update fires ONLY when no password is set yet. Two
			// concurrent setup calls can't clobber each other — the second becomes a
			// no-op instead of overwriting the first hash. The `if`-check above stays
			// for the clean FORBIDDEN message; this is the race-proof backstop.
			await ctx.db
				.insert(authConfig)
				.values({ userId: ctx.userId, passwordHash, failedAttemptsCount: 0 })
				.onConflictDoUpdate({
					target: authConfig.userId,
					set: { passwordHash, failedAttemptsCount: 0, lastFailureAt: null },
					setWhere: isNull(authConfig.passwordHash),
				});

			logAuthEvent("setup_password_set", { userId: ctx.userId });
			return { ok: true as const };
		}),
});
