import { sql } from "drizzle-orm";
import {
	index,
	sqliteTableCreator,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { Analysis } from "~/server/llm/schemas";
import type { TranscriptSegment } from "~/server/stt/types";

/**
 * Multi-project table-name prefix. Every user-owned table lands as `memo-call_<name>`.
 * @see https://orm.drizzle.team/docs/goodies#multi-project-schema
 */
export const createTable = sqliteTableCreator((name) => `memo-call_${name}`);

/**
 * `conversations.counterparty_state` (FR-025). `null` in the column — not a
 * member of this union — means "captured before FR-025; never resolved, never
 * will be". `pending` is the only value the INSERT path writes; the three
 * terminal values are written by the resolver alone (see the column comment).
 */
export type CounterpartyState =
	| "pending"
	| "known"
	| "withheld"
	| "unavailable";

export const users = createTable("users", (d) => ({
	id: d.text().primaryKey().notNull(),
	createdAt: d
		.integer({ mode: "timestamp" })
		.default(sql`(unixepoch())`)
		.notNull(),
}));

export const authConfig = createTable("auth_config", (d) => ({
	userId: d
		.text("user_id")
		.primaryKey()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	// Nullable until first-run wizard sets it; F-03 must guard.
	passwordHash: d.text("password_hash"),
	failedAttemptsCount: d
		.integer("failed_attempts_count", { mode: "number" })
		.default(0)
		.notNull(),
	lastFailureAt: d.integer("last_failure_at", { mode: "timestamp" }),
	createdAt: d
		.integer({ mode: "timestamp" })
		.default(sql`(unixepoch())`)
		.notNull(),
	updatedAt: d
		.integer({ mode: "timestamp" })
		.default(sql`(unixepoch())`)
		.$onUpdate(() => new Date())
		.notNull(),
}));

export const conversations = createTable(
	"conversations",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Telephony (FR-001/FR-002). `call_sid` and `recording_sid` are OPAQUE
		// provider tokens — handed straight back to whichever `TelephonyProvider` is
		// configured, never parsed here. Twilio fills them with `CallSid` /
		// `RecordingSid`; Zadarma with `pbx_call_id` / `call_id_with_rec`
		// (`telephony-provider-zadarma`, 2026-09). `call_sid` is the idempotency
		// anchor for `conv_user_callsid_uq`, which under Zadarma is a SECURITY
		// control, not an optimization: that vendor's webhook signature covers no
		// URL, timestamp or nonce, so a captured (body, signature) pair replays
		// forever and this index is what turns a replay into a no-op.
		//
		// ⚠️ Rows captured under a DIFFERENT provider keep that provider's tokens.
		// After a cutover they are meaningless to the new one, so anything that
		// hands a stored token back to the configured provider (the delete sweep)
		// must not read "not found" as success — see `zadarma.ts` deleteRecording.
		//
		// `recording_deleted_at` is the FR-002 delete
		// checkpoint — NULL means the recording is still resident at the provider,
		// stamped when deleteRecording succeeds (the delete sweep targets
		// recording_sid IS NOT NULL AND recording_deleted_at IS NULL).
		callSid: d.text("call_sid"),
		recordingSid: d.text("recording_sid"),
		recordingDeletedAt: d.integer("recording_deleted_at", {
			mode: "timestamp",
		}),
		startedAt: d.integer("started_at", { mode: "timestamp" }),
		endedAt: d.integer("ended_at", { mode: "timestamp" }),
		durationMs: d.integer("duration_ms", { mode: "number" }),
		// Transcript (FR-003). Whole-object JSON — access is always the full
		// transcript at once (FR-023 fetch-on-page-load).
		transcriptLanguage: d.text("transcript_language"),
		transcriptSegments: d
			.text("transcript_segments", { mode: "json" })
			.$type<TranscriptSegment[]>(),
		// Analysis (FR-004). Whole-object JSON, Zod-validated shape.
		analysis: d.text("analysis", { mode: "json" }).$type<Analysis>(),
		// Classification (FR-005 / S-03): columns added now, left NULL in S-01 so
		// S-03 needs no second ALTER. `*_overridden` flags a manual user override.
		category: d.text("category"),
		categoryOverridden: d
			.integer("category_overridden", { mode: "boolean" })
			.default(false)
			.notNull(),
		projectId: d
			.text("project_id")
			.references(() => projects.id, { onDelete: "set null" }),
		projectOverridden: d
			.integer("project_overridden", { mode: "boolean" })
			.default(false)
			.notNull(),
		// Re-analyze (FR-020/FR-021, S-06). `transcript_edited_at` is the O(1)
		// "Edytowano <date>" indicator stamped by `updateTranscript` (denormalized
		// from MAX(transcript_edits.edited_at) for read cost); `reanalyzed_at` is the
		// "Przeanalizowano ponownie <date>" indicator stamped by the success-only
		// reanalyze persist. Both nullable (NULL = never edited / never re-analyzed).
		transcriptEditedAt: d.integer("transcript_edited_at", {
			mode: "timestamp",
		}),
		reanalyzedAt: d.integer("reanalyzed_at", { mode: "timestamp" }),
		// Counterparty identity (FR-025, `caller-identity-in-archive`, 2026-10-19).
		// The OTHER party's number as the PROVIDER reported it, plus the
		// presentation name the provider attached to it (a HINT shown until the
		// user labels the number through the contact book — never authoritative),
		// plus an explicit state. THIS is the one table that holds a number the
		// user did not type, and the one row shape that links a recording to its
		// other party — the thing every comment below used to say must never
		// exist. It exists now by product decision (variant C, `prd.md` FR-025),
		// and it exists NARROWLY:
		//
		//  - ONE write path. Only `jobs/counterparty.ts` (`runCounterpartySweep`)
		//    may bind `counterparty_e164` / `counterparty_name_hint`, and only via
		//    `UPDATE … WHERE counterparty_state = 'pending'`. The INSERT path
		//    (`jobs/backfill.ts`, shared by webhook and reconcile sweep) carries no
		//    number: it sets the constant `'pending'` and nothing else. A source
		//    guard (`jobs/counterparty-write-path.test.ts`) fails the suite if the
		//    column names appear anywhere else under `src/server`.
		//  - `counterparty_state` is NULLABLE WITH NO DEFAULT, on purpose. NULL means
		//    "captured before FR-025" and such rows NEVER receive a number — not by
		//    migration, not by an ad-hoc script (owner decision #4, no backfill).
		//    Values written by code: `pending` (set at insert) → `known` (number,
		//    optional hint) | `withheld` (provider gave no usable number: CLIR,
		//    anonymous) | `unavailable` (no statistics row within 24 h, or the
		//    candidate was the user's own GSM — `selfRefused`). Validated in TS,
		//    NOT by a CHECK constraint: a CHECK is an ALTER that recreates the
		//    table on sqlite and would silently drop the FTS triggers (0005).
		//  - Normalized BEFORE write: Polish numbers through `normalizePolishE164`
		//    (so `contacts.e164` joins byte-for-byte), anything else as `+` plus
		//    digits. The join to the contact book is BY VALUE (`LEFT JOIN contacts
		//    ON e164`), never a `contact_id` FK — deleting a contact returns the
		//    row to "number only" with no cascade and no dangling reference.
		//  - Never in a prompt (`analyze`/`classify` take the transcript only) and
		//    never in a log line (`_lib/redact.ts` + `redact-sinks.test.ts`).
		//  - Deleted with the conversation: same tuple, nothing to cascade.
		counterpartyE164: d.text("counterparty_e164"),
		counterpartyNameHint: d.text("counterparty_name_hint"),
		counterpartyState: d.text("counterparty_state").$type<CounterpartyState>(),
		createdAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
		updatedAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.$onUpdate(() => new Date())
			.notNull(),
	}),
	(t) => [
		index("conv_user_created_idx").on(t.userId, t.createdAt),
		// FR-025: meant for the list's contact filter (`WHERE counterparty_e164
		// = <the contact's number>`). user_id-first. ⚠️ DORMANT TODAY, measured
		// (full-plan impl-review, 2026-10-20, `EXPLAIN QUERY PLAN`): the planner
		// takes `conv_user_created_idx` for the filter, like the project index
		// below. The resolver's `pending` scan filters on `counterparty_state`,
		// which this index does not contain — it does not serve that scan.
		index("conv_user_counterparty_idx").on(t.userId, t.counterpartyE164),
		// For the list's project filter (`tag-vocabulary-control` phase 1 added
		// the predicate, phase 3 the index — impl-review F4). user_id-first like
		// every other index here. ⚠️ DORMANT TODAY, measured (impl-review phase
		// 3, F2): without table statistics SQLite's planner takes
		// `conv_user_created_idx` for BOTH the `= ?` and the `IS NULL` branch
		// (the `ORDER BY createdAt DESC LIMIT n` keyset makes that the right
		// call at tens of rows), and this app never runs `ANALYZE` /
		// `PRAGMA optimize`. After `ANALYZE` the `= ?` branch switches here;
		// the `IS NULL` branch never does. Kept as the cheap forward bet the
		// phase-1 review asked for — do NOT add `ANALYZE` at boot just for it.
		index("conv_user_project_idx").on(t.userId, t.projectId),
		// Idempotency for retried Twilio webhooks: one conversation per (user, call).
		// Partial so the many NULL-call_sid rows (future non-telephony sources) are
		// exempt. drizzle-kit emits the WHERE predicate verbatim (unquoted).
		// Never switch the replay path to INSERT OR REPLACE / onConflictDoUpdate:
		// REPLACE's implicit delete does NOT fire the FTS5 AFTER DELETE trigger
		// (drizzle/0005) without `recursive_triggers`, so every replay would leave
		// a duplicate search-index row. Target-less onConflictDoNothing fires no
		// trigger at all, which is the correct no-op.
		uniqueIndex("conv_user_callsid_uq")
			.on(t.userId, t.callSid)
			.where(sql`call_sid IS NOT NULL`),
	],
);

export const projects = createTable(
	"projects",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: d.text().notNull(),
		category: d.text().notNull(),
		createdAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
		updatedAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.$onUpdate(() => new Date())
			.notNull(),
	}),
	(t) => [index("proj_user_category_idx").on(t.userId, t.category)],
);

export const tags = createTable(
	"tags",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: d
			.text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		name: d.text().notNull(),
		isUserEdited: d
			.integer("is_user_edited", { mode: "boolean" })
			.default(false)
			.notNull(),
		createdAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
	}),
	(t) => [
		index("tag_user_conv_idx").on(t.userId, t.conversationId),
		// Serves everything that works by NAME across conversations: the ranked
		// tag cloud (`GROUP BY name`, `tags/rank.ts`), global merge, and the
		// prompt vocabulary (`tag-vocabulary-control` phases 3–5). Before it the
		// only index was per-conversation, so every name-wise query scanned.
		index("tag_user_name_idx").on(t.userId, t.name),
	],
);

export const transcriptEdits = createTable(
	"transcript_edits",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: d
			.text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		editedAt: d
			.integer("edited_at", { mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
	}),
	(t) => [
		index("txedit_user_conv_at_idx").on(t.userId, t.conversationId, t.editedAt),
	],
);

/**
 * Dialing history for the outbound click-to-call surface (`/call`, FR-001).
 * Holds the distinct numbers the user has dialed THEMSELVES, so the picker can
 * offer them without retyping. One row per (user, number) — re-dialing bumps
 * `last_used_at` in place rather than appending, so this is a number *set*, not
 * a call log.
 *
 * PRIVACY — read before extending. Until this table, no phone number was
 * persisted anywhere in MemoCall; that was an audited property, not an
 * oversight (`context/domain/04-privacy-and-anonymity.md`, A-1, now partially
 * superseded). Two facts are deliberate and load-bearing:
 *
 *  - It stores only OUTBOUND numbers the user typed into the panel — never an
 *    inbound caller's number — and carries no `call_sid` and no conversation
 *    FK, so a row cannot by itself name the other party of a given recording.
 *  - `last_used_at` IS a wall-clock timestamp. Recency ordering was chosen over
 *    a date-free `seq` alternative (product decision, 2026-08-04), which means a
 *    row IS time-correlatable with `conversations.started_at`. That correlation
 *    is an accepted cost, not an oversight — do not describe this table as
 *    anonymous, and do not add a `call_sid` or conversation FK without
 *    revisiting the decision.
 *
 * ⚠️ THE RULE CHANGED TWICE. On 2026-09-15 (`contact-directory`) `contacts`
 * became the second table holding a number the user typed. On 2026-10-19
 * (`caller-identity-in-archive`, FR-025) `conversations` became the THIRD
 * table holding a number — and the only one holding a number the user did
 * NOT type: the other party's, as the provider reported it. The rule that
 * holds now is:
 *
 *   THREE tables may hold a phone number. `dialed_numbers` and `contacts`
 *   carry no `call_sid` or conversation FK. `dialed_numbers` holds only
 *   numbers the user typed into the panel; `contacts` holds those too, plus
 *   provider-reported numbers the user CHOSE to label from a conversation
 *   (`conversations.labelCounterparty` copies `counterparty_e164` into
 *   `contacts.e164` on that one deliberate click). Once copied, the number is
 *   the contact's — it outlives the conversation it came from, like any
 *   contact (FR-025: the number dies with the conversation; a LABEL is a
 *   separate, user-owned record). `conversations` holds the PROVIDER-reported
 *   counterparty number ON the recording's own row, written by exactly one
 *   path (`jobs/counterparty.ts`) and by nothing else.
 *
 * Everything outside those three — a job row, a log line, `processing_jobs.
 * last_error`, a `PendingRecording`, `BackfillInput`, a statistics mapper's
 * output — remains forbidden, and that half is now enforced by three source
 * guards (`_lib/redact-sinks.test.ts`, `jobs/counterparty-write-path.test.ts`,
 * `telephony/zadarma-statistics.test.ts`) rather than by this comment.
 */
export const dialedNumbers = createTable(
	"dialed_numbers",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Always E.164 — `normalizePolishE164` runs before this is written, so the
		// unique index below dedupes "600 100 200" and "+48600100200" to one row.
		e164: d.text("e164").notNull(),
		lastUsedAt: d
			.integer("last_used_at", { mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
	}),
	(t) => [
		// Serves the picker query: user-scoped, most recently dialed first.
		index("dialed_user_lastused_idx").on(t.userId, t.lastUsedAt),
		// One row per number — `calls.placeOutbound` upserts on this exact target.
		// A FULL (non-partial) unique index on purpose: the partial-index
		// `onConflictDoNothing({ target, where })` emission bug in lessons.md does
		// not apply, so a plain `onConflictDoUpdate({ target })` is safe here.
		uniqueIndex("dialed_user_e164_uq").on(t.userId, t.e164),
	],
);

/**
 * The contact book behind the `/call` picker (`contact-directory`, 2026-09-15).
 * A contact is a NAME the user gave, optionally carrying one phone number.
 *
 * WHY `e164` IS NULLABLE. A contact is allowed to exist with no number at all.
 * That is not a convenience — it is the shape the second slice
 * (`caller-identity-in-archive`) needs: a conversation can only ever point at a
 * NAME, and a name the user coined for someone they have never dialled must be
 * expressible. Forcing a number here would make the natural workaround
 * "invent a number", which is strictly worse for privacy than storing none.
 *
 * PRIVACY — the honest accounting, because "we only added names" understates it:
 *
 *  - This table carries no `call_sid` and no conversation FK — same two
 *    properties that keep `dialed_numbers` from being an identity index. The
 *    link between a recording and a name exists since FR-025 (2026-10-19), but
 *    it lives on `conversations` (`counterparty_e164`, matched to `e164` here BY
 *    VALUE), not here: this table still cannot, on its own, say who any
 *    recording was with. Until FR-025 the accounting read "`conversations`
 *    gains no column"; that sentence is history now and is kept only in
 *    `context/changes/caller-identity-in-archive/change.md`.
 *  - The pair (`dialed_numbers`, `contacts`) turns *a set of numbers that
 *    were dialled* into *a named address book*. The `last_used_at` ↔
 *    `conversations.createdAt` time correlation (NOT `started_at`, which is
 *    always NULL under Zadarma) yields a NAME rather than a number. That is a
 *    real cost, accepted with the 2026-09-15 decision (see
 *    `context/foundation/roadmap-post-mvp.md` S-06 and
 *    `context/domain/04-privacy-and-anonymity.md` §A-1).
 *  - There is deliberately NO foreign key between `contacts` and
 *    `dialed_numbers`, and NONE between `contacts` and `conversations`. All
 *    three are matched by `e164` value within one user, so "forget this number
 *    from the history", "delete this contact" and "delete this conversation"
 *    stay three distinct operations rather than one cascading into another —
 *    deleting a contact returns its conversations to "number only".
 *
 * The unique index on the number is PARTIAL (`WHERE e164 IS NOT NULL`). ⚠️ Read
 * what that does and does NOT buy, because the two are easy to swap. It does
 * NOT enable numberless contacts to coexist — SQLite treats every NULL as
 * distinct in a unique index, so a FULL index would permit those too. What it
 * buys is that the index only ever holds real numbers: no entry per numberless
 * contact, and the predicate states the intent where the next reader will look.
 * ⚠️ Because it is partial, the write path must NOT use
 * `onConflictDoNothing({ target, where })` — drizzle mis-positions the predicate
 * (lessons.md; it is the exact reason `dialed_user_e164_uq` above is full).
 * `contacts.create` does an explicit SELECT then INSERT, and maps a genuine
 * constraint violation via `isUniqueViolation`.
 */
export const contacts = createTable(
	"contacts",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: d.text().notNull(),
		// Always E.164 when present — `normalizePolishE164` runs in the router
		// before this is written, so "600 100 200" and "+48600100200" collide on
		// the partial unique index below rather than landing as two contacts.
		e164: d.text("e164"),
		createdAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
		updatedAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.$onUpdate(() => new Date())
			.notNull(),
	}),
	(t) => [
		// Serves the alphabetical list (`contacts.list`) and the `/call` select.
		index("contact_user_name_idx").on(t.userId, t.name),
		// One contact per number, per user. drizzle-kit emits the WHERE predicate
		// verbatim (unquoted), same as `conv_user_callsid_uq`.
		uniqueIndex("contact_user_e164_uq")
			.on(t.userId, t.e164)
			.where(sql`e164 IS NOT NULL`),
	],
);

/**
 * Durable source of truth for the FR-006 analysis pipeline. One row per call to
 * process; the in-process worker advances `status`
 * `pending → transcribing → analyzing → done` (terminal success) or `→ failed`
 * (terminal dead-letter, replayable). `attempt_count` is incremented at claim
 * time (atomic `UPDATE … WHERE status='pending' RETURNING`), capped at 5 by the
 * retry policy. Kept separate from `conversations` so the dead-letter view and
 * poller scan it cheaply.
 */
export const processingJobs = createTable(
	"processing_jobs",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: d
			.text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		// pending | transcribing | analyzing | done | failed
		status: d.text("status").default("pending").notNull(),
		// Job-kind discriminator (S-06). `analyze` = the audio-first first-run/replay
		// pipeline (processJob); `reanalyze` = the transcript-sourced re-analyze
		// pipeline (reanalyzeJob). The poller dispatches by this value. DEFAULT
		// 'analyze' so legacy rows + existing inserts (webhooks.ts) that omit `kind`
		// keep the first-run behavior unchanged.
		kind: d.text("kind").default("analyze").notNull(),
		attemptCount: d
			.integer("attempt_count", { mode: "number" })
			.default(0)
			.notNull(),
		lastError: d.text("last_error"),
		lastErrorCode: d.text("last_error_code"),
		nextRetryAt: d.integer("next_retry_at", { mode: "timestamp" }),
		createdAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
		updatedAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.$onUpdate(() => new Date())
			.notNull(),
	}),
	(t) => [
		// Serves the dead-letter view (WHERE status='failed') + the poller scan.
		index("job_user_status_idx").on(t.userId, t.status),
		index("job_user_conv_idx").on(t.userId, t.conversationId),
	],
);

/**
 * Calls whose conversation the user DELETED — the sweep's do-not-resurrect list
 * (`telephony-capture-reconciliation`, impl-review phase 2 F1).
 *
 * WHY THIS TABLE HAS TO EXIST. Capture reconciliation detects a lost note as
 * "a recording still resident at the provider that has NO `conversations` row".
 * A conversation the user deleted is byte-for-byte that state: `conversations.
 * delete` removes the recording at the provider **best-effort** (a failure is
 * logged, and the row is deleted anyway, because the row is its only handle and
 * there is no retry after it is gone). So without this list, one failed
 * provider-side delete means the note reappears within five minutes, its audio
 * is sent to Deepgram and Bedrock a SECOND time, and after the job succeeds it
 * stays — the user's deletion silently undone, with no error anywhere.
 *
 * WHY NOT THE OBVIOUS ALTERNATIVES. Refusing the delete when the provider call
 * fails makes deletion impossible whenever the vendor is down (and `zadarma.ts`
 * records that its DELETE path has never been exercised live). Soft-deleting the
 * conversation keeps the note's transcript and analysis on disk, which is the
 * opposite of what "Usuń" promises. A tombstone is the only shape that keeps
 * BOTH properties: delete always works, and deleted stays deleted.
 *
 * ⚠️ NO PHONE NUMBER, EVER. `call_sid` is a provider call token that names no
 * counterparty. Three tables persist a number (see the rule at
 * `dialed_numbers`), and this is not one of them: a tombstone OUTLIVES the
 * conversation, so a number here would survive the one deletion FR-025
 * promises removes it. Adding a number-shaped column here would turn a
 * deletion ledger into a caller-identity index that "Usuń" cannot clear.
 *
 * Rows are written for EVERY deleted conversation, not only the ones whose
 * provider delete failed — the cheap, uniform rule ("a deleted call is never
 * captured again") has no branch to get wrong, and a tombstone for an
 * already-deleted recording simply never matches anything.
 */
export const reconcileTombstones = createTable(
	"reconcile_tombstones",
	(d) => ({
		id: d.text().primaryKey().notNull(),
		userId: d
			.text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// NOT an FK to conversations: the whole point is to outlive that row.
		callSid: d.text("call_sid").notNull(),
		createdAt: d
			.integer({ mode: "timestamp" })
			.default(sql`(unixepoch())`)
			.notNull(),
	}),
	(t) => [
		// Serves the sweep's batch lookup AND makes re-deleting the same call_sid
		// (a backfill that was deleted again) an `ON CONFLICT DO NOTHING` no-op.
		uniqueIndex("tombstone_user_callsid_uq").on(t.userId, t.callSid),
	],
);
