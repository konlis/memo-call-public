import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { conversations, tags } from "~/server/db/schema";
import { normalizeTag } from "~/server/tags/normalize";
import { listTagsWithCounts } from "~/server/tags/rank";

/**
 * Tag review surface (PRD FR-017/018) — the editable projection of a
 * conversation's tags. S-05 promotes the `tags` table from a write-only shadow
 * of `analysis.candidateTags` to the UI's read/write source: `add` / `rename` /
 * `remove` per-tag, plus a `listWithCounts` query feeding the list-filter chips
 * (ranked by usage since `tag-vocabulary-control` phase 3) and `mergeGlobal`,
 * the one vocabulary-wide, IRREVERSIBLE operation (phase 4).
 *
 * All `protectedProcedure`, all scoped on the constant `ctx.userId` ('me') so
 * every call site stays multi-user-shaped from line one (mirrors `projects.ts`).
 * No schema migration — the `tags` table + per-row `is_user_edited` already exist
 * (F-01). The canonical name form is enforced by `normalizeTag` (the shared,
 * client-importable module), NOT Zod: Zod only rejects empty/whitespace input;
 * `normalizeTag` returning `null` (e.g. a punctuation-only name) is the explicit
 * BAD_REQUEST below.
 *
 * Per-tag `is_user_edited` flips true on EVERY user action (add/rename/accept-as-
 * is is the absence of an action). Collision-after-normalization MERGES: a
 * rename/add whose canonical result already exists on the same conversation
 * collapses onto the existing row (no duplicate) and flags the survivor
 * user-edited. There is no unique index on (conversation_id, name), so the merge
 * is app-code (pre-check + delete/update), not ON CONFLICT — covered by the
 * real-libsql tests (a stub lies about row counts after delete+update).
 */
export const tagsRouter = createTRPCRouter({
	// FR-018: add a tag to a conversation. Normalize → null ⇒ BAD_REQUEST;
	// conversation existence + user-scope guard ⇒ NOT_FOUND; if the canonical name
	// is already on the conversation, no-op merge (flag the survivor user-edited);
	// else insert a new user-edited row.
	add: protectedProcedure
		.input(
			z.object({
				conversationId: z.string().min(1),
				name: z.string().trim().min(1).max(200),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const name = normalizeTag(input.name);
			if (name === null) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Tag is empty after normalization",
				});
			}

			// Existence + user-scope guard BEFORE any write, so a foreign/unknown id is
			// a clean NOT_FOUND and never mutates anyone's data.
			const [conv] = await ctx.db
				.select({ id: conversations.id })
				.from(conversations)
				.where(
					and(
						eq(conversations.id, input.conversationId),
						eq(conversations.userId, ctx.userId),
					),
				);
			if (!conv) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No conversation with that id",
				});
			}

			// Collision check (mirrors projects.create's case-insensitive pre-check —
			// here names are already lowercase-canonical, so a plain equality suffices).
			const [existing] = await ctx.db
				.select({ id: tags.id })
				.from(tags)
				.where(
					and(
						eq(tags.userId, ctx.userId),
						eq(tags.conversationId, input.conversationId),
						eq(tags.name, name),
					),
				);

			let merged = false;
			if (existing) {
				// No-op merge: the tag is already there; the explicit add still flags it
				// user-edited (the user deliberately re-asserted it).
				merged = true;
				await ctx.db
					.update(tags)
					.set({ isUserEdited: true })
					.where(and(eq(tags.id, existing.id), eq(tags.userId, ctx.userId)));
			} else {
				await ctx.db.insert(tags).values({
					id: crypto.randomUUID(),
					userId: ctx.userId,
					conversationId: input.conversationId,
					name,
					isUserEdited: true,
				});
			}

			auditTagEvent("tag.added", {
				userId: ctx.userId,
				conversationId: input.conversationId,
				name,
				merged,
			});
			return { ok: true as const };
		}),

	// FR-018: rename a tag. Normalize → null ⇒ BAD_REQUEST; tag existence +
	// user-scope guard ⇒ NOT_FOUND; if the canonical name already exists on the
	// SAME conversation in a DIFFERENT row, merge (delete this row, flag the
	// survivor); else update name + flag user-edited.
	rename: protectedProcedure
		.input(
			z.object({
				tagId: z.string().min(1),
				name: z.string().trim().min(1).max(200),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const name = normalizeTag(input.name);
			if (name === null) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Tag is empty after normalization",
				});
			}

			const [tag] = await ctx.db
				.select({ id: tags.id, conversationId: tags.conversationId })
				.from(tags)
				.where(and(eq(tags.id, input.tagId), eq(tags.userId, ctx.userId)));
			if (!tag) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No tag with that id",
				});
			}

			// A different row on the same conversation already carrying the canonical
			// name ⇒ this rename collides → merge onto that survivor.
			const [collision] = await ctx.db
				.select({ id: tags.id })
				.from(tags)
				.where(
					and(
						eq(tags.userId, ctx.userId),
						eq(tags.conversationId, tag.conversationId),
						eq(tags.name, name),
						ne(tags.id, tag.id),
					),
				);

			let merged = false;
			if (collision) {
				merged = true;
				// Delete the renamed row, flag the survivor user-edited. delete+update,
				// NOT ON CONFLICT (no unique index); row count drops by one.
				await ctx.db
					.delete(tags)
					.where(and(eq(tags.id, tag.id), eq(tags.userId, ctx.userId)));
				await ctx.db
					.update(tags)
					.set({ isUserEdited: true })
					.where(and(eq(tags.id, collision.id), eq(tags.userId, ctx.userId)));
			} else {
				await ctx.db
					.update(tags)
					.set({ name, isUserEdited: true })
					.where(and(eq(tags.id, tag.id), eq(tags.userId, ctx.userId)));
			}

			auditTagEvent("tag.renamed", {
				userId: ctx.userId,
				conversationId: tag.conversationId,
				tagId: tag.id,
				name,
				merged,
			});
			return { ok: true as const };
		}),

	// FR-018: remove a tag. Existence + user-scope guard ⇒ NOT_FOUND → delete.
	remove: protectedProcedure
		.input(z.object({ tagId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const [tag] = await ctx.db
				.select({ id: tags.id, conversationId: tags.conversationId })
				.from(tags)
				.where(and(eq(tags.id, input.tagId), eq(tags.userId, ctx.userId)));
			if (!tag) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No tag with that id",
				});
			}

			await ctx.db
				.delete(tags)
				.where(and(eq(tags.id, tag.id), eq(tags.userId, ctx.userId)));

			auditTagEvent("tag.removed", {
				userId: ctx.userId,
				conversationId: tag.conversationId,
				tagId: tag.id,
			});
			return { ok: true as const };
		}),

	// FR-019: the user's distinct canonical tag names WITH usage counts, most
	// used first — feeds the list-filter chips (ranked cloud, visibility
	// threshold applied client-side). A one-liner over `tags/rank.ts` on
	// purpose: the workers (phase 5 vocabulary) call the same module function
	// without a tRPC context, so the ranking rule has exactly one home.
	listWithCounts: protectedProcedure.query(({ ctx }) =>
		listTagsWithCounts(ctx.db, { userId: ctx.userId }),
	),

	// `tag-vocabulary-control` phase 4: rename `from` → `to` across EVERY
	// conversation of the user, collapsing the two onto one row wherever a
	// conversation already carries both. The per-conversation `rename` above
	// cannot express this — it takes one `tagId` — so variants that survived the
	// visibility threshold (`faktury` ×4 next to `faktura` ×3) stayed side by
	// side and split the result set.
	//
	// IRREVERSIBLE: rows are deleted. The whole plan runs in ONE transaction so a
	// half-merged vocabulary cannot exist; the writes are grouped into at most
	// three statements (delete / rename / flag) rather than one per conversation.
	//
	// Idempotent by construction: a second run finds no `from` rows and reports
	// zeros instead of raising. That is deliberate — the panel is a two-select
	// form and a double submit (or a second tab) must not surface an error for an
	// operation whose goal is already reached.
	mergeGlobal: protectedProcedure
		.input(
			z.object({
				from: z.string().trim().min(1).max(200),
				to: z.string().trim().min(1).max(200),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const from = normalizeTag(input.from);
			const to = normalizeTag(input.to);
			if (from === null || to === null) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Tag is empty after normalization",
				});
			}
			// Compared AFTER normalization on purpose: `Faktury` and `faktury` are
			// the same tag, and merging a tag into itself would delete every row of
			// it on the "duplicate" branch.
			if (from === to) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Cannot merge a tag into itself",
				});
			}

			const outcome = await ctx.db.transaction(async (tx) => {
				const fromRows = await tx
					.select({
						id: tags.id,
						conversationId: tags.conversationId,
						isUserEdited: tags.isUserEdited,
					})
					.from(tags)
					.where(and(eq(tags.userId, ctx.userId), eq(tags.name, from)));

				if (fromRows.length === 0) {
					return { conversations: 0, renamedRows: 0, deletedRows: 0 };
				}

				// Group the source rows per conversation FIRST. The table has no
				// unique index on (conversation_id, name), so "two rows of the same
				// name on one conversation" is representable even though every
				// current write path avoids it; handling it here keeps a degenerate
				// row from being renamed into a fresh duplicate of the target.
				const byConversation = new Map<string, typeof fromRows>();
				for (const row of fromRows) {
					const bucket = byConversation.get(row.conversationId);
					if (bucket) bucket.push(row);
					else byConversation.set(row.conversationId, [row]);
				}

				// Only the target rows that share a conversation with a source row
				// matter — the rest of `to` is untouched by the merge.
				const targetRows = await tx
					.select({
						id: tags.id,
						conversationId: tags.conversationId,
						isUserEdited: tags.isUserEdited,
					})
					.from(tags)
					.where(
						and(
							eq(tags.userId, ctx.userId),
							eq(tags.name, to),
							inArray(tags.conversationId, [...byConversation.keys()]),
						),
					);
				const survivorByConversation = new Map<
					string,
					(typeof targetRows)[number]
				>();

				const deleteIds: string[] = [];
				const renameIds: string[] = [];
				const flagIds: string[] = [];

				// One survivor per conversation, symmetrically with the `from` side:
				// a second row of the TARGET name on the same conversation is the
				// same degenerate state the missing unique index permits, and leaving
				// it behind would make `listWithCounts` count that conversation twice
				// in the cloud (impl-review phase 4, F5).
				for (const row of targetRows) {
					if (survivorByConversation.has(row.conversationId)) {
						deleteIds.push(row.id);
					} else {
						survivorByConversation.set(row.conversationId, row);
					}
				}

				// EVERY survivor is flagged `is_user_edited = true`, whichever side
				// carried the flag before — a global merge IS a user decision about
				// the vocabulary, exactly like the per-conversation `rename` above,
				// which sets it unconditionally. This file's own invariant says the
				// flag "flips true on EVERY user action"; an earlier draft only OR-ed
				// the two sides, which left a merge of two purely-LLM variants at
				// `false`, and `reconcileTags` under the `merge` policy deletes
				// exactly the `false` rows — so the next re-analysis re-inserted the
				// abolished name, silently, after a confirmation that promised the
				// operation was irreversible (impl-review phase 4, F2). The cost is
				// that a merged tag then bypasses the cloud's ≥2 threshold and stays
				// visible; that is the correct trade — a curated tag is worth showing.
				for (const [conversationId, rows] of byConversation) {
					const survivor = survivorByConversation.get(conversationId);

					if (survivor) {
						// The conversation already carries `to`: drop every `from` row.
						for (const r of rows) deleteIds.push(r.id);
						if (!survivor.isUserEdited) flagIds.push(survivor.id);
					} else {
						// No `to` here: the first `from` row becomes it (the rename
						// statement sets the flag), any degenerate siblings are dropped.
						const [head, ...rest] = rows;
						if (!head) continue;
						renameIds.push(head.id);
						for (const r of rest) deleteIds.push(r.id);
					}
				}

				// Delete before rename so no intermediate state has two rows named
				// `to` on one conversation. Every statement stays scoped on `userId`
				// as well as the ids (multi-user-shaped call sites, CLAUDE.md).
				// `inArray` binds one parameter per id; at MVP scale (tens of
				// conversations) that is far under SQLite's variable ceiling — a
				// vocabulary reaching thousands of rows per name would need chunking.
				if (deleteIds.length > 0) {
					await tx
						.delete(tags)
						.where(
							and(eq(tags.userId, ctx.userId), inArray(tags.id, deleteIds)),
						);
				}
				if (renameIds.length > 0) {
					await tx
						.update(tags)
						.set({ name: to, isUserEdited: true })
						.where(
							and(eq(tags.userId, ctx.userId), inArray(tags.id, renameIds)),
						);
				}
				if (flagIds.length > 0) {
					await tx
						.update(tags)
						.set({ isUserEdited: true })
						.where(and(eq(tags.userId, ctx.userId), inArray(tags.id, flagIds)));
				}

				return {
					conversations: byConversation.size,
					renamedRows: renameIds.length,
					deletedRows: deleteIds.length,
				};
			});

			auditTagEvent("tag.merged_global", {
				userId: ctx.userId,
				from,
				to,
				...outcome,
			});
			return { ok: true as const, ...outcome };
		}),
});

/**
 * Structured-JSON audit line on stderr — parity with
 * `conversation.classification_overridden` / `project.deleted` (same shape +
 * channel, visible in `fly logs`). `merged` records whether the action collapsed
 * onto an existing canonical row. Inline (not a module) — these are the only call
 * sites, mirroring the override/delete audits in the sibling routers.
 */
function auditTagEvent(
	event: "tag.added" | "tag.renamed" | "tag.removed" | "tag.merged_global",
	fields: {
		userId: string;
		/** Absent for `tag.merged_global` — it spans every conversation. */
		conversationId?: string;
		name?: string;
		tagId?: string;
		merged?: boolean;
		/** `tag.merged_global` only: the two names and what the merge touched. */
		from?: string;
		to?: string;
		conversations?: number;
		renamedRows?: number;
		deletedRows?: number;
	},
): void {
	console.error(JSON.stringify({ ts: Date.now(), event, ...fields }));
}
