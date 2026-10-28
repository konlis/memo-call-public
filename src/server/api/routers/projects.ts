import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { safeErrorMessage } from "~/server/_lib/redact";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { conversations, projects } from "~/server/db/schema";
import { tombstoneCallSids } from "~/server/jobs/backfill";
import { createProjectInput } from "~/server/projects/schema";
import { telephony } from "~/server/telephony";

/**
 * Project management surface (PRD FR-013/014/015): create / list-with-counts /
 * delete. All `protectedProcedure`, all scoped on the constant `ctx.userId`
 * ('me') so every call site stays multi-user-shaped from line one (mirrors
 * `jobs.ts` / `conversations.ts`). No schema migration — the `projects` table +
 * the `conversations.project_id ON DELETE SET NULL` orphan FK already exist
 * (F-01).
 */
export const projectsRouter = createTRPCRouter({
	// FR-013: add a project. App-layer uniqueness — a pre-insert case-insensitive
	// existence check within the category, NOT a DB unique index (keeps the slice
	// migration-free). The TOCTOU window between check and insert is accepted for
	// the strict-single-user page-load model; if multi-user ever lands, promote to
	// a COLLATE NOCASE unique index (own migration + ON-CONFLICT test).
	create: protectedProcedure
		.input(createProjectInput)
		.mutation(async ({ ctx, input }) => {
			const existing = await ctx.db
				.select({ id: projects.id })
				.from(projects)
				.where(
					and(
						eq(projects.userId, ctx.userId),
						eq(projects.category, input.category),
						sql`lower(${projects.name}) = lower(${input.name})`,
					),
				)
				.limit(1);
			if (existing.length > 0) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "A project with this name already exists in this category",
				});
			}

			const [row] = await ctx.db
				.insert(projects)
				.values({
					id: crypto.randomUUID(),
					userId: ctx.userId,
					name: input.name,
					category: input.category,
				})
				.returning();
			return row;
		}),

	// FR-014: projects with a per-project conversation count, ordered (category,
	// name). The relational API has no `groupBy`, so this is the core builder with
	// a LEFT JOIN — so zero-conversation projects still return count 0. The
	// joined-conversation user-scope predicate lives in the JOIN ON (the `and`),
	// NOT the WHERE: `conversations.project_id` does not enforce same-user, and a
	// user predicate in WHERE would turn the LEFT JOIN effectively INNER (the
	// unmatched row's user_id is NULL → fails the predicate), silently dropping
	// zero-count projects. `count(conversations.id)` (not `count(*)`) yields 0 for
	// the no-match row.
	list: protectedProcedure.query(({ ctx }) =>
		ctx.db
			.select({
				id: projects.id,
				name: projects.name,
				category: projects.category,
				conversationCount: sql<number>`count(${conversations.id})`.mapWith(
					Number,
				),
			})
			.from(projects)
			.leftJoin(
				conversations,
				and(
					eq(conversations.projectId, projects.id),
					eq(conversations.userId, ctx.userId),
				),
			)
			.where(eq(projects.userId, ctx.userId))
			.groupBy(projects.id)
			.orderBy(asc(projects.category), asc(projects.name)),
	),

	// FR-015: delete a project AND hard-delete its assigned conversations (a HARD
	// cascade — reverses the earlier SET-NULL orphan design). The cascade runs in
	// app code, NOT via the FK: `conversations.project_id` is intentionally left
	// `ON DELETE SET NULL` because the FR-002 recording cleanup below needs an
	// interception point a DB-level cascade can't provide. Conversation dependents
	// (tags, transcript_edits, processing_jobs) still cascade off conversations.id
	// (PRAGMA foreign_keys = ON per connection), so deleting the conversation rows
	// cleans those up. Mirrors `conversations.delete`'s recording-cleanup + audit.
	delete: protectedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Existence + user-scope guard BEFORE any conversation is touched, so a
			// foreign/unknown id is a clean 404 and never deletes anyone's data.
			const [project] = await ctx.db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.id, input.id), eq(projects.userId, ctx.userId)));
			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No project with that id",
				});
			}

			// FR-002 best-effort cleanup: proactively delete each still-resident
			// recording at the provider BEFORE the conversation rows (their only
			// handle) disappear — the delete sweep keys off the row, so this is the
			// last chance. A failure is logged, NOT fatal, and must not abort the
			// cascade (mirrors `conversations.delete` + the sweep's error-log shape).
			// Non-atomicity note: unlike `conversations.delete` (single row deleted
			// immediately), if a provider delete SUCCEEDS here and the bulk delete
			// below then throws, that conversation survives with `recording_sid` set
			// and `recording_deleted_at` still NULL. This is self-healing — the
			// background `runDeleteSweep` re-attempts the (404-tolerant) provider
			// delete and then stamps `recording_deleted_at`, so no audio is orphaned.
			const resident = await ctx.db
				.select({
					id: conversations.id,
					recordingSid: conversations.recordingSid,
				})
				.from(conversations)
				.where(
					and(
						eq(conversations.projectId, input.id),
						eq(conversations.userId, ctx.userId),
						isNotNull(conversations.recordingSid),
						isNull(conversations.recordingDeletedAt),
					),
				);
			for (const row of resident) {
				if (!row.recordingSid) continue;
				try {
					await telephony.deleteRecording({ recordingSid: row.recordingSid });
				} catch (err) {
					console.error(
						JSON.stringify({
							ts: Date.now(),
							event: "project.delete_recording_failed",
							userId: ctx.userId,
							projectId: input.id,
							conversationId: row.id,
							error: safeErrorMessage(err),
						}),
					);
				}
			}

			// Hard-delete the project's conversations; dependents cascade off
			// conversations.id. `returning` yields the deleted count for the audit AND
			// the `call_sid`s to bury.
			//
			// The delete and its TOMBSTONES are one transaction, and that atomicity is
			// the guarantee: capture reconciliation reads "recording still resident at
			// the provider, no `conversations` row" as a lost note, which is exactly
			// what this cascade produces for every conversation whose best-effort
			// provider delete above failed. Deleted without tombstones, the whole
			// project's notes come back within five minutes and are re-sent to
			// Deepgram + Bedrock. See `reconcile_tombstones` in `schema.ts`.
			const deletedConversations = await ctx.db.transaction(async (tx) => {
				const deleted = await tx
					.delete(conversations)
					.where(
						and(
							eq(conversations.projectId, input.id),
							eq(conversations.userId, ctx.userId),
						),
					)
					.returning({ id: conversations.id, callSid: conversations.callSid });
				await tombstoneCallSids(tx, {
					userId: ctx.userId,
					callSids: deleted.map((r) => r.callSid),
				});
				return deleted;
			});

			await ctx.db
				.delete(projects)
				.where(and(eq(projects.id, input.id), eq(projects.userId, ctx.userId)));

			// Audit the irreversible destructive op (parity with conversation.deleted):
			// structured JSON on stderr, visible in `fly logs`.
			console.error(
				JSON.stringify({
					ts: Date.now(),
					event: "project.deleted",
					userId: ctx.userId,
					projectId: input.id,
					conversationCount: deletedConversations.length,
				}),
			);
			return { ok: true as const };
		}),
});
