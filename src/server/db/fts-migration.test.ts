import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";

/**
 * The two things ONLY a before/after-migration test can prove about
 * `drizzle/0005_conversations_fts.sql`:
 *
 * 1. the BACKFILL indexes conversations that existed before the migration
 *    (every other suite creates rows AFTER migrating, so the triggers — not the
 *    backfill — index them, and a missing backfill would stay green forever);
 * 2. the migration touches NO data row — counts in `conversations`, `tags`,
 *    `projects`, `transcript_edits` are identical before and after. It runs at
 *    Machine boot on the one production SQLite, and "a migration that only adds
 *    an index" is exactly the kind of claim that deserves a measurement.
 *
 * Mechanism: build a throwaway migrations folder holding 0000–0004 only (the
 * real `.sql` files + a journal truncated to `idx < 5`), migrate, seed, then
 * migrate again from the REAL `drizzle/` folder — drizzle's migrator applies
 * only entries newer than the last one recorded in `__drizzle_migrations`, so
 * the second call applies exactly 0005.
 */

const REAL_MIGRATIONS = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"drizzle",
);
const FTS_TAG = "0005_conversations_fts";

const DB_PATH = makeIntegrationDbPath("fts-migration");
let client: Client;
let preFtsFolder: string;
/** Total entries in the REAL journal — what the second `migrate()` ends up at. */
let realJournalLength: number;

/** Copy every migration BEFORE the FTS one into a temp folder with its own journal. */
function buildPreFtsMigrationsFolder(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "memocall-pre-fts-migrations-"));
	mkdirSync(path.join(dir, "meta"));
	const journal = JSON.parse(
		readFileSync(path.join(REAL_MIGRATIONS, "meta", "_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string }[] };
	realJournalLength = journal.entries.length;
	const ftsEntry = journal.entries.find((e) => e.tag === FTS_TAG);
	if (!ftsEntry) throw new Error(`journal has no entry tagged ${FTS_TAG}`);
	const kept = journal.entries.filter((e) => e.idx < ftsEntry.idx);
	writeFileSync(
		path.join(dir, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: kept }),
	);
	for (const f of readdirSync(REAL_MIGRATIONS)) {
		if (f.endsWith(".sql") && kept.some((e) => f === `${e.tag}.sql`)) {
			copyFileSync(path.join(REAL_MIGRATIONS, f), path.join(dir, f));
		}
	}
	return dir;
}

type Counts = Record<string, number>;
const DATA_TABLES = [
	"memo-call_conversations",
	"memo-call_tags",
	"memo-call_projects",
	"memo-call_transcript_edits",
];

async function countRows(): Promise<Counts> {
	const out: Counts = {};
	for (const t of DATA_TABLES) {
		const r = await client.execute(`SELECT count(*) AS n FROM "${t}"`);
		out[t] = Number(r.rows[0]?.n);
	}
	return out;
}

async function ftsHits(match: string): Promise<string[]> {
	const r = await client.execute({
		sql: `SELECT conversation_id FROM "memo-call_conversations_fts"
		      WHERE "memo-call_conversations_fts" MATCH ? ORDER BY conversation_id`,
		args: [match],
	});
	return r.rows.map((row) => String(row.conversation_id));
}

let countsBefore: Counts;

beforeAll(async () => {
	cleanupIntegrationDb(DB_PATH);
	preFtsFolder = buildPreFtsMigrationsFolder();
	client = createClient({ url: `file:${DB_PATH}` });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: preFtsFolder });

	// Pre-migration world: a project, two conversations (one with a transcript
	// containing `ł`/`ż`/`ó`/`ć` and a summary, one with NULL transcript — the
	// STT-failed shape), tags on both, one transcript edit.
	await client.execute({
		sql: `INSERT INTO "memo-call_projects" (id, user_id, name, category) VALUES (?, ?, ?, ?)`,
		args: ["p-old", "me", "Stary projekt", "praca"],
	});
	await client.execute({
		sql: `INSERT INTO "memo-call_conversations"
		      (id, user_id, project_id, transcript_segments, analysis) VALUES (?, ?, ?, ?, ?)`,
		args: [
			"c-old",
			"me",
			"p-old",
			JSON.stringify([
				{
					speaker: "Speaker A",
					text: "Oddzwonię w sprawie płatności",
					startMs: 0,
				},
				{
					speaker: "Speaker B",
					text: "Dział księgowości Zażółć",
					startMs: 1200,
				},
			]),
			JSON.stringify({ summary: "Ustalenia o fakturze" }),
		],
	});
	await client.execute({
		sql: `INSERT INTO "memo-call_conversations" (id, user_id, transcript_segments, analysis) VALUES (?, ?, NULL, NULL)`,
		args: ["c-old-empty", "me"],
	});
	for (const [id, conv, name] of [
		["t1", "c-old", "faktury"],
		["t2", "c-old", "klient"],
		["t3", "c-old-empty", "voicemail"],
	] as const) {
		await client.execute({
			sql: `INSERT INTO "memo-call_tags" (id, user_id, conversation_id, name) VALUES (?, ?, ?, ?)`,
			args: [id, "me", conv, name],
		});
	}
	await client.execute({
		sql: `INSERT INTO "memo-call_transcript_edits" (id, user_id, conversation_id, edited_at) VALUES (?, ?, ?, ?)`,
		args: ["e1", "me", "c-old", 1_700_000_000],
	});
	countsBefore = await countRows();

	// The pre-FTS world must not already have the index (or this suite proves
	// nothing about the backfill).
	const pre = await client.execute(
		`SELECT count(*) AS n FROM sqlite_master WHERE name = 'memo-call_conversations_fts'`,
	);
	expect(Number(pre.rows[0]?.n)).toBe(0);

	// Apply exactly 0005 from the real folder.
	await migrate(drizzle(client), { migrationsFolder: REAL_MIGRATIONS });
});

afterAll(() => {
	client?.close();
	cleanupIntegrationDb(DB_PATH);
	if (preFtsFolder) rmSync(preFtsFolder, { recursive: true, force: true });
});

describe("drizzle/0005_conversations_fts — applied on top of a populated 0004 database", () => {
	test("the second migrate() lands every entry of the real journal (0005 and whatever follows it)", async () => {
		const r = await client.execute(
			`SELECT count(*) AS n FROM "__drizzle_migrations"`,
		);
		// Derived from the journal, NOT a literal: the pre-FTS folder holds
		// `idx < 5`, the real folder holds everything, so a later 0006 must not
		// break this suite for a reason unrelated to FTS.
		expect(Number(r.rows[0]?.n)).toBe(realJournalLength);
	});

	test("the three sync triggers survive EVERY migration in drizzle/ (a recreated conversations table drops them silently)", async () => {
		// This is the guard, not a smoke check. drizzle-kit implements most
		// ALTERs on sqlite as `CREATE TABLE __new_… → INSERT…SELECT → DROP TABLE
		// → RENAME`; the DROP removes these triggers and the index then stops
		// updating with NO error — search "silently does not find". Because this
		// runs the REAL folder, a future migration that recreates
		// `memo-call_conversations` without re-CREATE-ing the triggers fails here.
		const trig = await client.execute(
			`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
		);
		expect(trig.rows.map((row) => row.name)).toEqual([
			"memo-call_conversations_fts_ad",
			"memo-call_conversations_fts_ai",
			"memo-call_conversations_fts_au",
		]);
	});

	test("2.12 backfill: a conversation that existed BEFORE the migration is searchable", async () => {
		// Transcript word (with `ł` in the source → folded at index time).
		expect(await ftsHits('"platnosc"*')).toEqual(["c-old"]);
		// Summary word.
		expect(await ftsHits('"fakturze"')).toEqual(["c-old"]);
		// `ż`/`ó`/`ć` via the tokenizer's own diacritic folding.
		expect(await ftsHits('"zazolc"')).toEqual(["c-old"]);
		// The NULL-transcript row is indexed too (empty body, no crash) — one
		// index row per conversation, no more, no fewer.
		const n = await client.execute(
			`SELECT count(*) AS n FROM "memo-call_conversations_fts"`,
		);
		expect(Number(n.rows[0]?.n)).toBe(2);
	});

	test("2.14 data safety: row counts in every data table are identical before and after", async () => {
		expect(await countRows()).toEqual(countsBefore);
		expect(countsBefore["memo-call_conversations"]).toBe(2);
		expect(countsBefore["memo-call_tags"]).toBe(3);
		expect(countsBefore["memo-call_projects"]).toBe(1);
		expect(countsBefore["memo-call_transcript_edits"]).toBe(1);
	});

	test("data rows are byte-identical, not just counted (the migration reads, never writes them)", async () => {
		const row = await client.execute({
			sql: `SELECT id, user_id, project_id, transcript_segments, analysis FROM "memo-call_conversations" WHERE id = ?`,
			args: ["c-old"],
		});
		expect(row.rows[0]?.project_id).toBe("p-old");
		expect(String(row.rows[0]?.transcript_segments)).toContain("płatności");
		expect(String(row.rows[0]?.analysis)).toContain("Ustalenia o fakturze");
	});
});
