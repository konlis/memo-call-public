import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
	createContactInput,
	updateContactInput,
} from "~/server/contacts/schema";
import { isUniqueViolation } from "~/server/contacts/unique-violation";
import { contacts } from "~/server/db/schema";
import { normalizePolishE164 } from "~/server/telephony/phone";

/**
 * Contact-book surface (`contact-directory`, 2026-09-15): create / list / update
 * / delete a named contact with an optional phone number. All
 * `protectedProcedure`, all scoped on the constant `ctx.userId` ('me') so every
 * call site stays multi-user-shaped from line one (mirrors `projects.ts`).
 *
 * ⚠️ AUDIT LINES CARRY NEITHER THE NAME NOR THE NUMBER. `calls.placeOutbound`
 * already refuses to log the number it dialled; here the stake is higher,
 * because a contact's NAME *is* the identity. A line reading
 * `{name: "Marek — warsztat", e164: "+48…"}` would reconstruct, inside Fly's
 * ~7-day log window, exactly the association this table is careful not to link
 * to a recording. Every audit line below carries `{event, ts, userId,
 * contactId}` and nothing else — and the test asserts the EXACT key set, not
 * the absence of `name` (absence also passes when the field is misspelled, or
 * when the audit was never written at all).
 *
 * ⚠️ THE ONE PLACE A NAME IS ALLOWED TO TRAVEL is the `CONFLICT` message below,
 * which names the colliding contact so the user can act on it. That is
 * deliberate, and it is safe for ONE non-obvious reason worth writing down
 * (impl-review phase 1, F4): `src/app/api/trpc/[trpc]/route.ts` echoes
 * `error.message` to stderr from `onError`, but that handler is gated on
 * `env.NODE_ENV === "development"` and is `undefined` in production — so the
 * name reaches the authenticated owner's screen and never Fly's ~7-day log
 * window. Un-gating that handler, or logging a TRPCError message anywhere else,
 * silently breaks the rule this file is otherwise careful about.
 *
 * ⚠️ NO `onConflict*` ANYWHERE IN THIS FILE. `contact_user_e164_uq` is a
 * PARTIAL unique index and drizzle mis-positions the predicate in
 * `onConflictDoNothing({ target, where })` (lessons.md — the same bug that made
 * `dialed_user_e164_uq` full). The duplicate-number path is an explicit SELECT
 * (for a message naming the colliding contact) plus a `try`/`catch` around the
 * write that maps ONLY a recognized unique violation onto `CONFLICT`. The index
 * is the guarantee; the SELECT is the courtesy.
 */
export const contactsRouter = createTRPCRouter({
	create: protectedProcedure
		.input(createContactInput)
		.mutation(async ({ ctx, input }) => {
			const e164 = normalizeContactNumber(input.e164 ?? null);

			if (e164 !== null) {
				const [collision] = await ctx.db
					.select({ name: contacts.name })
					.from(contacts)
					.where(and(eq(contacts.userId, ctx.userId), eq(contacts.e164, e164)))
					.limit(1);
				if (collision) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `Ten numer należy już do kontaktu „${collision.name}”`,
					});
				}
			}

			const id = crypto.randomUUID();
			let row: typeof contacts.$inferSelect | undefined;
			try {
				[row] = await ctx.db
					.insert(contacts)
					.values({ id, userId: ctx.userId, name: input.name, e164 })
					.returning();
			} catch (err) {
				// Lost the race between the SELECT above and this INSERT. ONLY a
				// recognized unique violation becomes CONFLICT; everything else — FK,
				// NOT NULL, a dead connection — propagates untouched, because turning
				// those into "this number is taken" is a silent failure with a
				// confident wrong diagnosis.
				if (!isUniqueViolation(err)) throw err;
				throw new TRPCError({
					code: "CONFLICT",
					message: "Ten numer należy już do innego kontaktu",
				});
			}

			auditContactEvent("contact.created", {
				userId: ctx.userId,
				contactId: id,
			});
			return row;
		}),

	list: protectedProcedure.query(({ ctx }) =>
		ctx.db
			.select({ id: contacts.id, name: contacts.name, e164: contacts.e164 })
			.from(contacts)
			.where(eq(contacts.userId, ctx.userId))
			.orderBy(asc(contacts.name)),
	),

	// Existence + user-scope guard ⇒ NOT_FOUND; a number already held by a
	// DIFFERENT contact ⇒ CONFLICT (reject, not merge — unlike `tags.rename`,
	// which merges precisely because it has no unique index to lean on).
	// `e164: null` writes NULL and is the ONLY way to clear a number.
	update: protectedProcedure
		.input(updateContactInput)
		.mutation(async ({ ctx, input }) => {
			const [existing] = await ctx.db
				.select({ id: contacts.id })
				.from(contacts)
				.where(and(eq(contacts.id, input.id), eq(contacts.userId, ctx.userId)));
			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No contact with that id",
				});
			}

			const e164 = normalizeContactNumber(input.e164);

			// No collision check when clearing: the index is partial, so any number
			// of contacts may sit without a number.
			if (e164 !== null) {
				const [collision] = await ctx.db
					.select({ name: contacts.name })
					.from(contacts)
					.where(
						and(
							eq(contacts.userId, ctx.userId),
							eq(contacts.e164, e164),
							ne(contacts.id, input.id),
						),
					)
					.limit(1);
				if (collision) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `Ten numer należy już do kontaktu „${collision.name}”`,
					});
				}
			}

			try {
				await ctx.db
					.update(contacts)
					.set({ name: input.name, e164 })
					.where(
						and(eq(contacts.id, input.id), eq(contacts.userId, ctx.userId)),
					);
			} catch (err) {
				if (!isUniqueViolation(err)) throw err;
				throw new TRPCError({
					code: "CONFLICT",
					message: "Ten numer należy już do innego kontaktu",
				});
			}

			auditContactEvent("contact.updated", {
				userId: ctx.userId,
				contactId: input.id,
			});
			return { ok: true as const };
		}),

	delete: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const [existing] = await ctx.db
				.select({ id: contacts.id })
				.from(contacts)
				.where(and(eq(contacts.id, input.id), eq(contacts.userId, ctx.userId)));
			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No contact with that id",
				});
			}

			await ctx.db
				.delete(contacts)
				.where(and(eq(contacts.id, input.id), eq(contacts.userId, ctx.userId)));

			auditContactEvent("contact.deleted", {
				userId: ctx.userId,
				contactId: input.id,
			});
			return { ok: true as const };
		}),
});

/**
 * Apply the server's one number rule. `null` in ⇒ `null` out (no number, a
 * first-class state); a non-empty string that `normalizePolishE164` rejects ⇒
 * `BAD_REQUEST`.
 *
 * ⚠️ The validator is NOT relaxed for the contact book. It is the single
 * validation boundary for what reaches the telephony provider, and a contact's
 * number is dialable — see `phone.ts`. A foreign number is therefore not
 * creatable, and that is a product decision, not an oversight.
 */
function normalizeContactNumber(raw: string | null): string | null {
	if (raw === null) return null;
	const e164 = normalizePolishE164(raw);
	if (e164 === null) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid phone number",
		});
	}
	return e164;
}

/**
 * One audit line per mutation, on stderr, visible in `fly logs` — parity with
 * `project.deleted` / `call.placed`. The key set is FIXED and asserted by the
 * test; do not extend it with anything that names the person.
 */
function auditContactEvent(
	event: "contact.created" | "contact.updated" | "contact.deleted",
	fields: { userId: string; contactId: string },
): void {
	console.error(
		JSON.stringify({
			ts: Date.now(),
			event,
			userId: fields.userId,
			contactId: fields.contactId,
		}),
	);
}
