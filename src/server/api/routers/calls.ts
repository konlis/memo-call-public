import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "~/env";
import { safeErrorMessage } from "~/server/_lib/redact";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { contacts, dialedNumbers } from "~/server/db/schema";
import { telephony } from "~/server/telephony";
import { normalizePolishE164 } from "~/server/telephony/phone";

/**
 * How many past numbers the `/call` picker offers. Small on purpose: the list
 * sits above the dial input, and a long one turns a convenience into a wall of
 * phone numbers on screen.
 */
const HISTORY_LIMIT = 8;

/**
 * Outbound click-to-call (US-01 / FR-001) — the initiation side of S-01. The
 * ONLY consumer of `telephony.placeCall`. Normalizes the recipient number,
 * requires `PUBLIC_BASE_URL` to build the absolute recording-status callback,
 * places the call, and audits it. Fire-and-forget: no realtime/polling (honors
 * the no-streaming constraint). The placed call fires the SAME `recording-status`
 * callback as an inbound one, so the worker→STT→LLM→panel pipeline is reused with
 * zero changes — this router adds only the initiation.
 */
export const callsRouter = createTRPCRouter({
	placeOutbound: protectedProcedure
		.input(z.object({ to: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Single validation boundary: the provider trusts `to` verbatim.
			const to = normalizePolishE164(input.to);
			if (to === null) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid phone number",
				});
			}

			// Outbound is initiated server-side (no incoming request to derive an
			// origin from), so the callback URL must be absolute. Mirrors the inbound
			// factory guard (telephony/index.ts): fail loud rather than POST a
			// relative callback Twilio can't reach.
			if (!env.PUBLIC_BASE_URL) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Outbound calling is not configured",
				});
			}
			const recordingStatusCallbackUrl = `${env.PUBLIC_BASE_URL}/api/telephony/recording-status`;

			let callSid: string;
			try {
				({ callSid } = await telephony.placeCall({
					to,
					recordingStatusCallbackUrl,
				}));
			} catch (err) {
				// Generic to the client (no vendor detail leaked); the precise reason
				// (auth / transport / missing callerId) lives only in the audit log.
				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "call.place_failed",
						userId: ctx.userId,
						error: safeErrorMessage(err),
					}),
				);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Could not place the call",
				});
			}

			// Audit the successful initiation (parity with the conversations audit
			// shape: structured JSON on stderr, visible in `fly logs`). `callSid` is
			// logged but deliberately NOT written next to the number in
			// `dialed_numbers` — that link is what would turn the picker into a
			// per-conversation identity map (see the schema's privacy note).
			console.error(
				JSON.stringify({
					ts: Date.now(),
					event: "call.placed",
					userId: ctx.userId,
					callSid,
				}),
			);

			// Dialing history for the picker. Best-effort ON PURPOSE: the call is
			// already placed by this point, so a failed history write must never
			// surface to the user as a failed call. Upsert (not insert) keeps one
			// row per number — re-dialing bumps recency instead of appending, so the
			// table stays a number set rather than a call log. Target is the FULL
			// unique index `dialed_user_e164_uq`, so the partial-index
			// `onConflictDoNothing({ target, where })` emission bug in lessons.md
			// does not apply here.
			try {
				await ctx.db
					.insert(dialedNumbers)
					.values({ id: crypto.randomUUID(), userId: ctx.userId, e164: to })
					.onConflictDoUpdate({
						target: [dialedNumbers.userId, dialedNumbers.e164],
						set: { lastUsedAt: new Date() },
					});
			} catch (err) {
				console.error(
					JSON.stringify({
						ts: Date.now(),
						event: "call.history_write_failed",
						userId: ctx.userId,
						error: safeErrorMessage(err),
					}),
				);
			}

			return { ok: true as const, callSid };
		}),

	// The `/call` picker: numbers this user has dialed before, most recent first,
	// each carrying the name of the contact holding that number when there is
	// one (`contact-directory` phase 3). Scoped on the constant `ctx.userId` like
	// every other router, so the call site stays multi-user-shaped from line one.
	//
	// ⚠️ THE USER PREDICATE BELONGS IN THE JOIN `ON`, NEVER IN THE `WHERE`. A
	// dialed number with no contact joins to an all-NULL right side, and
	// `NULL = 'me'` is NULL — so the same predicate in `WHERE` turns this LEFT
	// JOIN effectively INNER and every UNNAMED number disappears from the picker.
	// Exactly the trap documented at `projects.ts:58-66`.
	//
	// Matching is BY VALUE, deliberately without a foreign key: "forget this
	// number" and "delete this contact" stay two separate operations (see
	// `forget` below). The row count cannot grow either — `contact_user_e164_uq`
	// permits at most one contact per (user, number), so `HISTORY_LIMIT` still
	// caps NUMBERS, not join products.
	history: protectedProcedure.query(({ ctx }) =>
		ctx.db
			.select({
				id: dialedNumbers.id,
				e164: dialedNumbers.e164,
				lastUsedAt: dialedNumbers.lastUsedAt,
				contactName: contacts.name,
			})
			.from(dialedNumbers)
			.leftJoin(
				contacts,
				and(
					eq(contacts.e164, dialedNumbers.e164),
					eq(contacts.userId, ctx.userId),
				),
			)
			.where(eq(dialedNumbers.userId, ctx.userId))
			.orderBy(desc(dialedNumbers.lastUsedAt))
			.limit(HISTORY_LIMIT),
	),

	// Drop one number from the history. Not decoration: this table is one of
	// three places MemoCall persists a phone number (`contacts` since
	// `contact-directory`, `conversations.counterparty_e164` since FR-025), and
	// the one that keeps a dialled number with no conversation attached, so the
	// user needs a way to remove one they did not mean to keep (the copy on a
	// conversation goes when that conversation is deleted). Deleting the history
	// row does NOT delete a contact that happens to carry the same number — the two are matched by
	// value, never by a foreign key, precisely so these stay separate
	// operations. Idempotent — deleting an unknown or foreign id is a no-op,
	// never an error.
	forget: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await ctx.db
				.delete(dialedNumbers)
				.where(
					and(
						eq(dialedNumbers.userId, ctx.userId),
						eq(dialedNumbers.id, input.id),
					),
				);
			return { ok: true as const };
		}),
});
