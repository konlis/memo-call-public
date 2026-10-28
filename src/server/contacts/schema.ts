import { z } from "zod";

/**
 * Shared contact input — importable by BOTH the `contacts` router (server
 * validation) and the client forms (pre-validation), mirroring
 * `~/server/projects/schema`. Zero server-only imports so the client can pull it
 * without dragging server deps in.
 *
 * `name` uses `z.string().trim()` (NOT `.transform(s => s.trim())`): `.trim()`
 * returns a `ZodString`, so it stays chainable with `.min`/`.max` AND yields the
 * trimmed value — normalizing identically on client + server, and trimming
 * BEFORE the length check. (`.transform()` returns `ZodEffects`, which has no
 * `.min`/`.max`.)
 *
 * The number is NOT normalized here. `normalizePolishE164` is a server rule
 * (`~/server/telephony/phone`) and the router is the one place that applies it;
 * the client may run the same pre-check for a faster message, exactly as
 * `call-form.tsx` already does.
 */

/**
 * Creating a contact. An ABSENT `e164` means "a contact with no number" — the
 * intended, first-class state, not a degraded one.
 */
export const createContactInput = z.object({
	name: z.string().trim().min(1).max(60),
	// `.max(32)` is a stated boundary, not a filter (full-plan impl-review, F8):
	// `normalizePolishE164` rejects anything long anyway, so this changes no
	// outcome — it just stops `name` being the only field here with a written
	// upper bound. E.164 tops out at 15 digits; 32 leaves room for separators.
	e164: z.string().trim().min(1).max(32).optional(),
});

/**
 * Editing a contact. ⚠️ `e164` is `.nullable()`, NOT `.optional()`, and the
 * difference is load-bearing: an emptied form field must send an explicit
 * `null` (meaning "clear it"), never `""`, which would fail `.min(1)` and
 * surface as `BAD_REQUEST` instead of clearing. The router must not have to
 * guess whether an empty string was a form artefact or an intent.
 *
 * ⚠️ `.nullable()` leaves the KEY REQUIRED — it is not `.optional()` plus null.
 * There is therefore no "leave it alone" state at all: a payload that omits
 * `e164`, or sends `undefined`, is rejected with `Required` exactly like a
 * malformed one (measured against this repo's zod, impl-review phase 1 F1 —
 * an earlier version of this comment claimed the opposite). So **every edit
 * must send both fields**, and a phase-2 form that omits the number field gets
 * a `BAD_REQUEST`, not a no-op. If a partial edit is ever wanted, that is a
 * deliberate change to `.nullish()` plus a router branch distinguishing
 * `undefined` (keep) from `null` (clear) — not something the current schema
 * quietly supports.
 */
export const updateContactInput = z.object({
	id: z.string().min(1),
	name: z.string().trim().min(1).max(60),
	// Same bound as `createContactInput` — see the note there.
	e164: z.string().trim().min(1).max(32).nullable(),
});

export type CreateContactInput = z.infer<typeof createContactInput>;
export type UpdateContactInput = z.infer<typeof updateContactInput>;
