#!/usr/bin/env node
// Dev-only seeder for sample conversations so the /conversations list + category
// filter + status badges + "load more" can be exercised locally WITHOUT the real
// telephony -> STT -> LLM pipeline. Mirrors dev-seed-auth.mjs guards.
//
//   DATABASE_URL="file:./db.sqlite" npx tsx scripts/dev-seed-conversations.mjs
//
// Re-runnable: wipes only rows whose id starts with "seed-" (never real data).
// NOT for production — the real pipeline owns conversations there.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import {
	conversations,
	processingJobs,
	projects,
} from "../src/server/db/schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error(
		'[dev-seed-conversations] DATABASE_URL required ("file:./db.sqlite")',
	);
	process.exit(1);
}
if (process.env.NODE_ENV === "production") {
	console.error(
		"[dev-seed-conversations] refusing to run with NODE_ENV=production",
	);
	process.exit(1);
}
if (!databaseUrl.startsWith("file:")) {
	console.error(
		"[dev-seed-conversations] refusing: DATABASE_URL must be a local file: URL",
	);
	process.exit(1);
}

const USER = "me";

// Spec: status drives whether analysis is present (done) and which job row is
// seeded (in_progress -> a pending job; failed -> a failed job; done -> no job
// needed, analysis alone yields 'done'). NULL category appears ONLY under the
// "Wszystkie" filter — good for exercising FR-011.
const SPECS = [];
const add = (category, status, summary, withProject) =>
	SPECS.push({ category, status, summary, withProject });

add("praca", "in_progress", null, false);
add(null, "in_progress", null, false);
add(null, "failed", null, false);
add("prywatne", "failed", null, false);
for (let i = 0; i < 9; i++)
	add(
		"praca",
		"done",
		`Notatka robocza ${i + 1}: ustalenia i kolejne kroki z rozmowy.`,
		i % 2 === 0,
	);
for (let i = 0; i < 8; i++)
	add(
		"prywatne",
		"done",
		`Notatka prywatna ${i + 1}: przypomnienie, plany, drobne sprawy.`,
		false,
	);
add(null, "in_progress", null, false);
add(
	"praca",
	"done",
	"Krótkie podsumowanie ostatniej rozmowy z klientem.",
	true,
);
add("prywatne", "done", "Rozmowa rodzinna — szczegóły do zapamiętania.", false);
// 25 total -> exceeds the 20 page size, so "Wczytaj więcej" is exercisable.

const PROJECT_ID = "seed-proj-1";
const analysisFor = (summary) => ({
	summary,
	keyInsights: [],
	decisions: [],
	actionItems: [],
	candidateTags: [],
});

const base = Date.parse("2026-06-14T09:00:00.000Z");
const convRows = [];
const jobRows = [];
SPECS.forEach((s, i) => {
	const id = `seed-conv-${String(i + 1).padStart(2, "0")}`;
	convRows.push({
		id,
		userId: USER,
		// 1 minute apart, descending so index 1 is newest.
		createdAt: new Date(base - i * 60_000),
		category: s.category,
		analysis: s.status === "done" ? analysisFor(s.summary) : null,
		projectId: s.withProject ? PROJECT_ID : null,
	});
	if (s.status !== "done") {
		jobRows.push({
			id: `seed-job-${String(i + 1).padStart(2, "0")}`,
			userId: USER,
			conversationId: id,
			status: s.status === "failed" ? "failed" : "transcribing",
		});
	}
});

try {
	const client = createClient({ url: databaseUrl });
	await client.execute("PRAGMA foreign_keys = ON;");
	const db = drizzle(client);

	// Children before parents (FK); only seed-* rows.
	await client.execute(
		"DELETE FROM \"memo-call_processing_jobs\" WHERE id LIKE 'seed-%'",
	);
	await client.execute(
		"DELETE FROM \"memo-call_conversations\" WHERE id LIKE 'seed-%'",
	);
	await client.execute(
		"DELETE FROM \"memo-call_projects\" WHERE id LIKE 'seed-%'",
	);

	await db.insert(projects).values({
		id: PROJECT_ID,
		userId: USER,
		name: "Klient Alfa",
		category: "praca",
	});
	await db.insert(conversations).values(convRows);
	if (jobRows.length > 0) await db.insert(processingJobs).values(jobRows);

	console.log(
		`[dev-seed-conversations] seeded ${convRows.length} conversations (${jobRows.length} with in-progress/failed jobs) + 1 project for user='${USER}'`,
	);
	process.exit(0);
} catch (err) {
	console.error("[dev-seed-conversations] Failed:", err);
	process.exit(1);
}
