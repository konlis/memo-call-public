import { type Client, createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
	withFailingSelectFrom,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import {
	conversations,
	processingJobs,
	projects,
	tags,
} from "~/server/db/schema";
import { reanalyzeJob, reanalyzeKickoff } from "~/server/jobs/reanalyze";
import { pollOnce } from "~/server/jobs/scheduler";
import { backoff, type WorkerDeps } from "~/server/jobs/worker";
import { analyze as analyzeService } from "~/server/llm/analyze";
import { classify as classifyService } from "~/server/llm/classify";
import type { Analysis } from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";
import type { TranscriptResult, TranscriptSegment } from "~/server/stt/types";

// Real-libsql integration test (per CLAUDE.md "Lessons"): the kind-scoped atomic claim, the
// success-only persist transaction, and the per-tag merge are exactly the SQL a stub
// db can't exercise. We apply the real migrations to a throwaway DB and drive
// `reanalyzeJob` / `pollOnce` end-to-end.
const DB_PATH = makeIntegrationDbPath("reanalyze");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

const FIXED_NOW = new Date("2026-06-22T12:00:00.000Z");

const TRANSCRIPT: TranscriptSegment[] = [
	{ speaker: "Speaker A", text: "Dzień dobry.", startMs: 0, endMs: 2000 },
	{ speaker: "Speaker B", text: "Witam.", startMs: 2000, endMs: 4000 },
];

const priorAnalysis: Analysis = {
	summary: "Stare podsumowanie.",
	keyInsights: [],
	decisions: [],
	actionItems: [],
	candidateTags: ["stary"],
};

const newAnalysis: Analysis = {
	summary: "Nowe podsumowanie po ponownej analizie.",
	keyInsights: ["Nowa obserwacja."],
	decisions: ["Nowa decyzja."],
	actionItems: [],
	// `wspolny` deliberately collides with a seeded user-edited tag (dedup test).
	candidateTags: ["nowy-tag", "wspolny"],
};

const cannedTranscript: TranscriptResult = {
	segments: TRANSCRIPT,
	language: "pl-PL",
	durationMs: 4000,
};

type Tracker = {
	analyzeCalls: number;
	classifyCalls: number;
	transcribeCalls: number;
};

function makeDeps(over: Partial<WorkerDeps> = {}): {
	deps: WorkerDeps;
	tracker: Tracker;
} {
	const tracker: Tracker = {
		analyzeCalls: 0,
		classifyCalls: 0,
		transcribeCalls: 0,
	};
	const deps: WorkerDeps = {
		db,
		telephony: {
			recordingContentType: "audio/wav",
			async streamRecording(_input, sink) {
				await sink.close();
			},
			async deleteRecording() {
				/* noop */
			},
		},
		stt: {
			async transcribe() {
				tracker.transcribeCalls += 1;
				return cannedTranscript;
			},
		},
		analyze: async () => {
			tracker.analyzeCalls += 1;
			return newAnalysis;
		},
		// Default classify stub: files into the FIRST seeded project (a valid pair).
		classify: async (input) => {
			tracker.classifyCalls += 1;
			const p = input.projects[0];
			return p
				? {
						status: "classified",
						classification: { category: p.category, projectId: p.id },
					}
				: { status: "no_auto_assignment", attempts: 3 };
		},
		sttMode: "mock",
		userId: "me",
		now: () => FIXED_NOW,
		...over,
	};
	return { deps, tracker };
}

let convSeq = 0;

/** Seed a conversation (transcript + prior analysis present by default) + a job. */
async function seedConvJob(opts: {
	kind?: "analyze" | "reanalyze";
	status?: string;
	attemptCount?: number;
	segments?: TranscriptSegment[] | null;
	analysis?: Analysis | null;
	category?: string | null;
	categoryOverridden?: boolean;
	projectId?: string | null;
	projectOverridden?: boolean;
	recordingSid?: string | null;
}): Promise<{ conversationId: string; jobId: string }> {
	convSeq += 1;
	const conversationId = `conv-${convSeq}`;
	const jobId = `job-${convSeq}`;
	await db.insert(conversations).values({
		id: conversationId,
		userId: "me",
		callSid: `CA_${convSeq}`,
		recordingSid: opts.recordingSid === undefined ? null : opts.recordingSid,
		transcriptSegments:
			opts.segments === undefined ? TRANSCRIPT : opts.segments,
		transcriptLanguage: "pl-PL",
		analysis: opts.analysis === undefined ? priorAnalysis : opts.analysis,
		category: opts.category ?? null,
		categoryOverridden: opts.categoryOverridden ?? false,
		projectId: opts.projectId ?? null,
		projectOverridden: opts.projectOverridden ?? false,
	});
	await db.insert(processingJobs).values({
		id: jobId,
		userId: "me",
		conversationId,
		status: opts.status ?? "pending",
		kind: opts.kind ?? "reanalyze",
		attemptCount: opts.attemptCount ?? 0,
	});
	return { conversationId, jobId };
}

let projSeq = 0;
async function seedProject(category: "praca" | "prywatne"): Promise<string> {
	projSeq += 1;
	const id = `proj-${projSeq}`;
	await db.insert(projects).values({
		id,
		userId: "me",
		name: `Projekt ${projSeq}`,
		category,
	});
	return id;
}

async function seedTag(
	conversationId: string,
	name: string,
	isUserEdited: boolean,
): Promise<void> {
	await db.insert(tags).values({
		id: `tag-${conversationId}-${name}`,
		userId: "me",
		conversationId,
		name,
		isUserEdited,
	});
}

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_tags"');
	await client.execute('DELETE FROM "memo-call_processing_jobs"');
	await client.execute('DELETE FROM "memo-call_conversations"');
	await client.execute('DELETE FROM "memo-call_projects"');
});

async function jobRow(jobId: string) {
	const r = await client.execute({
		sql: 'SELECT status, attempt_count, next_retry_at, last_error_code FROM "memo-call_processing_jobs" WHERE id = ?',
		args: [jobId],
	});
	return r.rows[0];
}
async function convRow(conversationId: string) {
	const r = await client.execute({
		sql: 'SELECT analysis, reanalyzed_at, category, project_id FROM "memo-call_conversations" WHERE id = ?',
		args: [conversationId],
	});
	return r.rows[0];
}
async function convSegments(
	conversationId: string,
): Promise<TranscriptSegment[]> {
	const r = await client.execute({
		sql: 'SELECT transcript_segments FROM "memo-call_conversations" WHERE id = ?',
		args: [conversationId],
	});
	const raw = r.rows[0]?.transcript_segments;
	return raw ? (JSON.parse(String(raw)) as TranscriptSegment[]) : [];
}
async function tagRows(conversationId: string) {
	const r = await client.execute({
		sql: 'SELECT name, is_user_edited FROM "memo-call_tags" WHERE conversation_id = ? ORDER BY name',
		args: [conversationId],
	});
	return r.rows.map((row) => ({
		name: String(row.name),
		isUserEdited: Number(row.is_user_edited) === 1,
	}));
}

describe("reanalyzeJob — per-tag merge + analysis replacement", () => {
	test("keeps user-edited tags, regenerates auto tags, dedups a colliding candidate, stamps reanalyzed_at, replaces analysis", async () => {
		const { conversationId, jobId } = await seedConvJob({});
		// User-edited tags survive; `wspolny` collides with a regenerated candidate.
		await seedTag(conversationId, "wazne", true);
		await seedTag(conversationId, "wspolny", true);
		// Auto tag — must be regenerated away.
		await seedTag(conversationId, "stary-auto", false);

		const { deps, tracker } = makeDeps(); // analyze → newAnalysis (nowy-tag, wspolny)
		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(tracker.analyzeCalls).toBe(1);

		// Final tag set: the two user-edited survivors + the one fresh auto candidate.
		// `wspolny` appears EXACTLY once (the auto candidate was skipped on collision),
		// `stary-auto` is gone, `nowy-tag` is the only new auto row.
		expect(await tagRows(conversationId)).toEqual([
			{ name: "nowy-tag", isUserEdited: false },
			{ name: "wazne", isUserEdited: true },
			{ name: "wspolny", isUserEdited: true },
		]);

		// Analysis replaced; reanalyzed_at stamped.
		const conv = await convRow(conversationId);
		const analysis = JSON.parse(String(conv?.analysis)) as Analysis;
		expect(analysis.summary).toBe(newAnalysis.summary);
		expect(conv?.reanalyzed_at).not.toBeNull();

		// The transcript is the SOURCE — never rewritten by re-analyze.
		expect(await convSegments(conversationId)).toEqual(TRANSCRIPT);
	});

	test("merge POLICY: the write is per-tag — a user-edited tag is PRESERVED", async () => {
		// CHARACTERIZATION (Phase 4 of `refactor-opportunities`). The exact twin of
		// worker.test.ts's "first-run POLICY: … CLEARED". Same seed shape, opposite
		// outcome — stated as an executable fact so the Phase 5 extraction into one
		// shared reconciler cannot collapse two intentionally different semantics into
		// one. If Phase 5 breaks either policy, exactly one of this pair goes red and
		// names which policy was lost.
		//
		// Why the asymmetry is correct here: re-analyze runs on a conversation the
		// user has already curated, so a destructive rewrite would silently discard
		// their work (FR-021).
		const { conversationId, jobId } = await seedConvJob({});
		await seedTag(conversationId, "recznie-dodany", true);

		const { deps } = makeDeps(); // newAnalysis → candidateTags nowy-tag, wspolny
		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		// The user-edited row SURVIVES alongside the regenerated auto candidates.
		expect(await tagRows(conversationId)).toEqual([
			{ name: "nowy-tag", isUserEdited: false },
			{ name: "recznie-dodany", isUserEdited: true },
			{ name: "wspolny", isUserEdited: false },
		]);
	});

	test("merge DEPENDS on user-edited tags being stored canonically — a non-canonical survivor misses the collision (pins a dependency, NOT desired behavior)", async () => {
		// CHARACTERIZATION of a latent fragility, not an endorsement of it.
		//
		// The collision skip compares `normalizeTags(candidates)` — canonical — against
		// RAW survivor names. That is correct only while every user-edited tag is
		// stored in canonical form, which today holds because the tags router
		// normalizes on write (S-05). The invariant is currently defended by a comment
		// in reanalyze.ts; this test converts it into something that fails loudly.
		//
		// Seed a survivor whose stored name is NOT canonical and a candidate that
		// normalizes onto it. Expected outcome is TODAY's behavior: the collision is
		// missed and a near-duplicate auto row lands next to the user's tag. Phase 5
		// may keep or change this — but it must do so CONSCIOUSLY, which is exactly
		// what this test forces. If the reconciler starts comparing canonical-to-
		// canonical, this test goes red and the diff is the deliberate decision.
		const { conversationId, jobId } = await seedConvJob({});
		await seedTag(conversationId, "Klient Nowy", true); // non-canonical on purpose

		const { deps } = makeDeps({
			analyze: async () => ({
				...newAnalysis,
				candidateTags: ["Klient Nowy"], // normalizes to `klient-nowy`
			}),
		});
		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		// Two rows for one concept: the survivor kept verbatim, plus a canonical auto
		// duplicate the skip failed to recognize. (SQLite BINARY collation sorts the
		// uppercase `K` before the lowercase `k`.)
		expect(await tagRows(conversationId)).toEqual([
			{ name: "Klient Nowy", isUserEdited: true },
			{ name: "klient-nowy", isUserEdited: false },
		]);
	});
});

describe("reanalyzeJob — classification override guard", () => {
	test("preserves a user-overridden classification (classify NEVER called)", async () => {
		const autoProjectId = await seedProject("praca"); // what auto would pick
		const userProjectId = await seedProject("prywatne"); // the user's manual choice
		const { conversationId, jobId } = await seedConvJob({
			category: "prywatne",
			categoryOverridden: true,
			projectId: userProjectId,
			projectOverridden: true,
		});

		const { deps, tracker } = makeDeps({
			classify: async () => ({
				status: "classified",
				classification: { category: "praca", projectId: autoProjectId },
			}),
		});
		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(tracker.classifyCalls).toBe(0); // guard short-circuited the LLM
		const conv = await convRow(conversationId);
		// The user's manual classification survived untouched.
		expect(conv?.category).toBe("prywatne");
		expect(conv?.project_id).toBe(userProjectId);
		// Analysis content still regenerated even though classification was preserved.
		expect((JSON.parse(String(conv?.analysis)) as Analysis).summary).toBe(
			newAnalysis.summary,
		);
	});

	test("regenerates classification when neither flag is set", async () => {
		const projectId = await seedProject("praca");
		const { conversationId, jobId } = await seedConvJob({
			category: null,
			projectId: null,
		});

		const { deps, tracker } = makeDeps(); // default stub files into projects[0]
		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(tracker.classifyCalls).toBe(1);
		const conv = await convRow(conversationId);
		expect(conv?.category).toBe("praca");
		expect(conv?.project_id).toBe(projectId);
	});
});

describe("reanalyzeJob — success-only guarantee (failure never clobbers)", () => {
	test("a non-retryable ProviderError leaves prior analysis/tags/category untouched and dead-letters", async () => {
		const projectId = await seedProject("praca");
		const { conversationId, jobId } = await seedConvJob({
			category: "praca",
			projectId,
		});
		await seedTag(conversationId, "wazne", true);
		await seedTag(conversationId, "auto-stary", false);

		const { deps } = makeDeps({
			analyze: async (): Promise<Analysis> => {
				throw new ProviderError({ code: "invalid_response", message: "bad" });
			},
		});
		await reanalyzeJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("invalid_response");
		expect(Number(job?.attempt_count)).toBe(1);

		// Conversation is UNTOUCHED: prior analysis, classification, reanalyzed_at NULL.
		const conv = await convRow(conversationId);
		expect((JSON.parse(String(conv?.analysis)) as Analysis).summary).toBe(
			priorAnalysis.summary,
		);
		expect(conv?.reanalyzed_at).toBeNull();
		expect(conv?.category).toBe("praca");
		expect(conv?.project_id).toBe(projectId);
		// Both tags survive — the per-tag merge never ran (it's inside the success tx).
		expect(await tagRows(conversationId)).toEqual([
			{ name: "auto-stary", isUserEdited: false },
			{ name: "wazne", isUserEdited: true },
		]);
	});

	test("a retryable error under the cap re-enqueues (pending) with backoff; analysis preserved", async () => {
		const { conversationId, jobId } = await seedConvJob({});

		const { deps } = makeDeps({
			analyze: async (): Promise<Analysis> => {
				throw new ProviderError({ code: "transport", message: "boom" });
			},
		});
		await reanalyzeJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("pending");
		expect(job?.last_error_code).toBe("transport");
		// next_retry_at = FIXED_NOW + backoff(1). Stored as unix seconds.
		const expected = Math.floor((FIXED_NOW.getTime() + backoff(1)) / 1000);
		expect(Number(job?.next_retry_at)).toBe(expected);
		// Prior analysis preserved across the retry.
		const conv = await convRow(conversationId);
		expect((JSON.parse(String(conv?.analysis)) as Analysis).summary).toBe(
			priorAnalysis.summary,
		);
		expect(conv?.reanalyzed_at).toBeNull();
	});

	test("an empty transcript dead-letters (defensive) without touching the conversation", async () => {
		const { conversationId, jobId } = await seedConvJob({ segments: [] });

		const { deps, tracker } = makeDeps();
		await reanalyzeJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("invalid_response");
		expect(tracker.analyzeCalls).toBe(0); // never reached analyze with empty input
		expect((await convRow(conversationId))?.reanalyzed_at).toBeNull();
	});
});

describe("pollOnce — dispatch by kind", () => {
	// Observable-effect dispatch assertion (the repo convention — see scheduler.test.ts,
	// which asserts job-status effects rather than module spies). It is STRONGER than a
	// function spy here: `processJob` structurally ALWAYS calls `stt.transcribe` and
	// rewrites the transcript, while `reanalyzeJob` structurally NEVER does. So
	// `transcribeCalls===0` + `reanalyzed_at` stamped + transcript unchanged proves the
	// reanalyze job was routed to `reanalyzeJob`, not `processJob`.
	test("a pending kind='reanalyze' job is routed to reanalyzeJob (no STT, reanalyzed_at stamped)", async () => {
		const { conversationId, jobId } = await seedConvJob({ kind: "reanalyze" });

		const { deps, tracker } = makeDeps();
		await pollOnce(deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(tracker.transcribeCalls).toBe(0); // reanalyze path never transcribes
		expect((await convRow(conversationId))?.reanalyzed_at).not.toBeNull();
		expect(await convSegments(conversationId)).toEqual(TRANSCRIPT); // not rewritten
	});

	test("a pending kind='analyze' job is still routed to processJob (STT runs)", async () => {
		// Complement: the default-kind first-run job must keep flowing through the
		// audio-first worker. A recordingSid + mock STT makes processJob transcribe.
		const { conversationId, jobId } = await seedConvJob({
			kind: "analyze",
			analysis: null,
			recordingSid: "RE_disp",
		});

		const { deps, tracker } = makeDeps();
		await pollOnce(deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(tracker.transcribeCalls).toBe(1); // processJob ran STT
		expect((await convRow(conversationId))?.reanalyzed_at).toBeNull(); // not a reanalyze
	});
});

describe("reanalyzeKickoff — last-resort catch is status-scoped", () => {
	// Gap N-2 (Phase 6 of `refactor-opportunities`), the twin of the `kickoff`
	// block in worker.test.ts. `reanalyzeJob` handles its own pipeline errors, so
	// this catch fires only if the claim SQL itself throws. Its dead-letter write
	// is scoped to `analyzing` — the ONE status this attempt could still own — so
	// it cannot clobber a row that was re-enqueued (`pending`) or that succeeded
	// (`done`). Narrower than the worker's two-status guard, and untested until now.

	/**
	 * A db proxy whose FIRST `update(...)` throws (the atomic claim) and whose
	 * SECOND passes through (the dead-letter write), resolving `settled` once that
	 * write lands — making the fire-and-forget path deterministically awaitable.
	 */
	function makeClaimCrashDb(): { faultyDb: typeof db; settled: Promise<void> } {
		let firstUpdate = true;
		let resolveSettled: () => void = () => {};
		const settled = new Promise<void>((r) => {
			resolveSettled = r;
		});
		const faultyDb = new Proxy(db, {
			get(target, prop, recv) {
				if (prop !== "update") return Reflect.get(target, prop, recv);
				return (table: unknown) => {
					if (firstUpdate) {
						firstUpdate = false;
						throw new Error("reanalyze claim SQL exploded");
					}
					const builder = target.update(table as never);
					return {
						set: (values: unknown) => {
							const withValues = builder.set(values as never);
							return {
								where: async (predicate: unknown) => {
									try {
										return await withValues.where(predicate as never);
									} finally {
										resolveSettled();
									}
								},
							};
						},
					};
				};
			},
		}) as typeof db;
		return { faultyDb, settled };
	}

	test("dead-letters a row still owned by this attempt (analyzing)", async () => {
		const { jobId } = await seedConvJob({ status: "analyzing" });
		const { faultyDb, settled } = makeClaimCrashDb();
		const { deps } = makeDeps({ db: faultyDb });

		reanalyzeKickoff(jobId, deps);
		await settled;

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		// A plain Error (not a ProviderError) maps to the `unknown` code.
		expect(String(job?.last_error_code)).toBe("unknown");
	});

	test("leaves a re-enqueued row alone (pending)", async () => {
		const { jobId } = await seedConvJob({ status: "pending" });
		const { faultyDb, settled } = makeClaimCrashDb();
		const { deps } = makeDeps({ db: faultyDb });

		reanalyzeKickoff(jobId, deps);
		await settled;

		expect((await jobRow(jobId))?.status).toBe("pending");
	});

	test("never clobbers a succeeded row (done)", async () => {
		const { jobId } = await seedConvJob({ status: "done" });
		const { faultyDb, settled } = makeClaimCrashDb();
		const { deps } = makeDeps({ db: faultyDb });

		reanalyzeKickoff(jobId, deps);
		await settled;

		expect((await jobRow(jobId))?.status).toBe("done");
	});
});

describe("reanalyzeJob — tag vocabulary (phase 5)", () => {
	/**
	 * Why this pipeline needs its own coverage: a re-analysis that ran WITHOUT the
	 * dictionary would re-coin the variant names a global merge had just
	 * consolidated, so every transcript edit would quietly undo the cleanup. The
	 * worker-side tests cannot show that — different worker, different call site.
	 */
	async function seedTaggedConversation(names: string[]): Promise<void> {
		const { conversationId } = await seedConvJob({ status: "done" });
		for (const name of names) {
			await seedTag(conversationId, name, false);
		}
	}

	test("hands analyze() the qualifying tag names of the job's user", async () => {
		await seedTaggedConversation(["faktury", "jednorazowy"]);
		await seedTaggedConversation(["faktury"]);

		const { jobId } = await seedConvJob({});
		let seen: ReadonlyArray<string> | undefined;
		const { deps } = makeDeps({
			analyze: async (input) => {
				seen = input.vocabulary;
				return newAnalysis;
			},
		});

		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		// Whole-list equality, not membership: the one-off must NOT be padded in.
		expect(seen).toEqual(["faktury"]);
	});

	test("a failed vocabulary read degrades to empty — the job still reaches done", async () => {
		await seedTaggedConversation(["faktury"]);
		await seedTaggedConversation(["faktury"]);

		const { conversationId, jobId } = await seedConvJob({});
		let seen: ReadonlyArray<string> | undefined;
		const { deps } = makeDeps({
			db: withFailingSelectFrom(db, tags, "SQLITE_BUSY: database is locked"),
			analyze: async (input) => {
				seen = input.vocabulary;
				return newAnalysis;
			},
		});

		const lines: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => {
			lines.push(String(l));
		});
		try {
			await reanalyzeJob(jobId, deps);
		} finally {
			spy.mockRestore();
		}

		// Success-only persist still applies: the job lands AND the new analysis
		// replaced the prior one, so the degradation cost nothing but the dictionary.
		expect((await jobRow(jobId))?.status).toBe("done");
		expect(seen).toEqual([]);
		expect(await tagRows(conversationId)).not.toHaveLength(0);

		const reported = lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.event === "job.vocabulary_unavailable");
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ jobId, conversationId });
	});
});

describe("reanalyzeJob — the counterparty never reaches a prompt (FR-025, A-5)", () => {
	// Runtime twin of the worker.test.ts block, for the transcript-sourced
	// pipeline: a re-analysis reads the conversation row that now carries the
	// number and the hint, and must still hand `analyze()`/`classify()` only
	// the transcript. Placeholder number and name, chosen to be greppable.
	const NUMBER = "+48512345678";
	const HINT = "Zenobia Testowa";

	function promptCapture(projectId: string): {
		provider: LlmProvider;
		prompts: string[];
	} {
		const prompts: string[] = [];
		const provider: LlmProvider = {
			async generateStructured({ prompt, schema }) {
				prompts.push(prompt);
				return (
					schema.safeParse(newAnalysis).success
						? newAnalysis
						: { category: "praca", projectId }
				) as never;
			},
		};
		return { provider, prompts };
	}

	test("a known conversation with a number and a hint: both prompts carry the transcript, neither carries the number or the hint", async () => {
		const projectId = await seedProject("praca");
		const { conversationId, jobId } = await seedConvJob({});
		await db
			.update(conversations)
			.set({
				counterpartyState: "known",
				counterpartyE164: NUMBER,
				counterpartyNameHint: HINT,
			})
			.where(eq(conversations.id, conversationId));
		const { provider, prompts } = promptCapture(projectId);
		const { deps } = makeDeps({
			analyze: (input) => analyzeService(input, { provider }),
			classify: (input) => classifyService(input, { provider }),
		});

		await reanalyzeJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) {
			expect(prompt).toContain("Dzień dobry.");
		}
		expect(prompts[1]).toContain(`id="${projectId}"`);

		const joined = prompts.join("\n");
		expect(joined.replace(/\D/g, "")).not.toContain("512345678");
		expect(joined).not.toContain("Zenobia");
		expect(joined).not.toContain("Testowa");
	});
});
