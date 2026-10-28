-- HAND-WRITTEN migration (tag-vocabulary-control, phase 2) — do NOT
-- regenerate-overwrite. drizzle-kit models neither virtual tables nor
-- triggers, so `db:generate` can never emit this file; it is paired with a
-- hand-made `meta/0005_snapshot.json` (a copy of 0004 with a fresh `id` and
-- `prevId` = 0004's `id`) and a hand-added `_journal.json` entry. The snapshot
-- is byte-identical in `tables` to 0004 on purpose: nothing drizzle models
-- changes here, so a later `db:generate` sees no spurious diff.
--
-- Full-text search index over each conversation's transcript + summary.
--
-- SYNC IS BY TRIGGER, NOT BY CODE. `conversations` is written from four places
-- today (worker done-txn, reanalyze done-txn, `updateTranscript`, delete) and a
-- fifth will appear. A write path that forgets the index does not fail — it
-- yields a search that silently does not find, which is indistinguishable from
-- "no such conversation". Triggers make the number of paths to remember zero.
--
-- Bound by `conversation_id`, NOT by rowid: rowids get reused after a delete,
-- which would tie the index to the table's physical layout.
--
-- BODY EXPRESSION (repeated verbatim four times below — SQL has no macros):
--   segments' `$.text` flattened by json_each + group_concat (so `speaker`,
--   `startMs`, `endMs` are NOT searchable), joined with `analysis.$.summary`,
--   then `ł`/`Ł` folded to `l`. The fold is needed because `unicode61
--   remove_diacritics 2` decomposes ą ć ę ń ó ś ż ź canonically but `ł`
--   (U+0142) is a separate letter with NO decomposition — without it
--   "płatności", "dział", "złoty" are unsearchable. The SAME fold MUST be
--   applied to the query phrase on the TS side (`src/server/conversations/
--   search.ts`); asymmetry in either direction is a silent zero for every
--   Polish word containing `ł`.
--
-- ⚠️ TRIGGERS DIE WITH THE TABLE. drizzle-kit implements most ALTERs on
-- sqlite as `CREATE TABLE __new_… → INSERT…SELECT → DROP TABLE → RENAME`;
-- the DROP silently removes these three triggers and the index stops
-- updating with NO error. Any future migration that recreates
-- `memo-call_conversations` MUST re-CREATE the three triggers in the same
-- file (copy them from here). Guard: `src/server/db/fts-migration.test.ts`
-- asserts their names after applying the full `drizzle/` folder.
--
-- A NON-JSON or NON-ARRAY `transcript_segments` now fails the WRITE
-- (`SQLITE_ERROR: malformed JSON` from json_each/json_extract inside the
-- trigger), not just the search. Unreachable today — every writer goes
-- through drizzle `mode: "json"` typed as `TranscriptSegment[]` — but a raw
-- INSERT of a bad value used to succeed and no longer does. NULL is fine.
--
-- ⚠️ `db:push` (local dev) sees this virtual table + its five FTS5 shadow
-- tables through `tablesFilter: ["memo-call_*"]` and does not know them from
-- schema.ts — `drizzle.config.ts` excludes `memo-call_conversations_fts*` for
-- that reason. Keep that exclusion if the table is ever renamed.
--
-- BACKFILL RUNS AT MACHINE BOOT (docker-entrypoint.sh → scripts/migrate.mjs →
-- server.js), inside the migration's transaction. At today's scale (tens of
-- conversations) that is seconds. Ceiling: at ~10k conversations move the
-- backfill out of the migration into a background sweep — a boot that takes
-- minutes reads as a failed deploy to Fly's health check.
CREATE VIRTUAL TABLE `memo-call_conversations_fts` USING fts5(
	`body`,
	`conversation_id` UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `memo-call_conversations_fts_ai`
AFTER INSERT ON `memo-call_conversations`
BEGIN
	INSERT INTO `memo-call_conversations_fts` (`body`, `conversation_id`)
	VALUES (
		replace(replace(
			coalesce((SELECT group_concat(json_extract(value, '$.text'), ' ')
			          FROM json_each(NEW.transcript_segments)), '')
			|| ' ' || coalesce(json_extract(NEW.analysis, '$.summary'), ''),
		'ł', 'l'), 'Ł', 'l'),
		NEW.id
	);
END;
--> statement-breakpoint
-- fts5 has no usable `UPDATE … WHERE conversation_id` (the column is UNINDEXED),
-- so an update is DELETE + INSERT. Without the DELETE the index accumulates one
-- stale row per rewrite and an old phrase keeps matching forever. Fires only
-- when an indexed source column changes — the delete sweep's
-- `recording_deleted_at` stamp or a category override must not rewrite the
-- index row.
CREATE TRIGGER `memo-call_conversations_fts_au`
AFTER UPDATE OF `transcript_segments`, `analysis` ON `memo-call_conversations`
BEGIN
	DELETE FROM `memo-call_conversations_fts` WHERE `conversation_id` = OLD.id;
	INSERT INTO `memo-call_conversations_fts` (`body`, `conversation_id`)
	VALUES (
		replace(replace(
			coalesce((SELECT group_concat(json_extract(value, '$.text'), ' ')
			          FROM json_each(NEW.transcript_segments)), '')
			|| ' ' || coalesce(json_extract(NEW.analysis, '$.summary'), ''),
		'ł', 'l'), 'Ł', 'l'),
		NEW.id
	);
END;
--> statement-breakpoint
CREATE TRIGGER `memo-call_conversations_fts_ad`
AFTER DELETE ON `memo-call_conversations`
BEGIN
	DELETE FROM `memo-call_conversations_fts` WHERE `conversation_id` = OLD.id;
END;
--> statement-breakpoint
-- Backfill: every conversation that exists BEFORE this migration gets its index
-- row now, so search is complete from the first second — an index with
-- triggers but no backfill is a partially-correct state that looks working.
-- Same body expression as the triggers. Hand-edited; do NOT regenerate.
INSERT INTO `memo-call_conversations_fts` (`body`, `conversation_id`)
SELECT
	replace(replace(
		coalesce((SELECT group_concat(json_extract(value, '$.text'), ' ')
		          FROM json_each(c.transcript_segments)), '')
		|| ' ' || coalesce(json_extract(c.analysis, '$.summary'), ''),
	'ł', 'l'), 'Ł', 'l'),
	c.id
FROM `memo-call_conversations` c;
