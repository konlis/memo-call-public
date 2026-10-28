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
import {
	backoff,
	kickoff,
	MAX_ATTEMPTS,
	processJob,
	type WorkerDeps,
} from "~/server/jobs/worker";
import { analyze as analyzeService } from "~/server/llm/analyze";
import { classify as classifyService } from "~/server/llm/classify";
import type { Analysis } from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";
import type {
	SttProvider,
	TranscriptResult,
	TranscriptSegment,
} from "~/server/stt/types";

// Real-libsql integration test (per CLAUDE.md "Lessons"): the atomic claim
// (`UPDATE … WHERE status='pending' RETURNING`) and the persist-and-done
// transaction are exactly the SQL a stub db can't exercise. We apply the real
// migrations to a throwaway DB and drive `processJob` end-to-end.
const DB_PATH = makeIntegrationDbPath("worker");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

const FIXED_NOW = new Date("2026-06-10T12:00:00.000Z");

const cannedTranscript: TranscriptResult = {
	segments: [
		{ speaker: "Speaker A", text: "Dzień dobry.", startMs: 0, endMs: 2000 },
		{
			speaker: "Speaker B",
			text: "Witam serdecznie.",
			startMs: 2000,
			endMs: 4000,
		},
	],
	language: "pl-PL",
	durationMs: 4000,
};

const cannedAnalysis: Analysis = {
	summary: "Krótka rozmowa powitalna.",
	keyInsights: ["Pozytywny ton."],
	decisions: [],
	actionItems: ["Oddzwonić jutro."],
	candidateTags: ["powitanie", "follow-up"],
};

/** Track collaborator calls so we can assert no-op / once / never semantics. */
type Tracker = {
	transcribeCalls: number;
	analyzeCalls: number;
	classifyCalls: number;
	streamCalls: number;
	deleteCalls: string[];
};

function makeDeps(over: Partial<WorkerDeps> = {}): {
	deps: WorkerDeps;
	tracker: Tracker;
} {
	const tracker: Tracker = {
		transcribeCalls: 0,
		analyzeCalls: 0,
		classifyCalls: 0,
		streamCalls: 0,
		deleteCalls: [],
	};
	const deps: WorkerDeps = {
		db,
		telephony: {
			// Same value the real + mock providers declare. A stub that lied here
			// would hide a worker that mis-declares the upload's MIME type.
			recordingContentType: "audio/wav",
			async streamRecording(_input, sink) {
				tracker.streamCalls += 1;
				// Close the sink so the WritableStream doesn't dangle.
				await sink.close();
			},
			async deleteRecording(input) {
				tracker.deleteCalls.push(input.recordingSid);
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
			return cannedAnalysis;
		},
		// Default classify stub: files the conversation into the FIRST seeded project
		// (a valid pair by construction). Tests that need exhaustion / errors override
		// this. Never reached when the project list is empty (the worker short-circuits).
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

/** Seed a conversation + a job in the given status; returns their ids. */
async function seedJob(opts: {
	status?: string;
	attemptCount?: number;
	recordingSid?: string | null;
	nextRetryAt?: Date | null;
	/**
	 * Job kind. Omitted from the INSERT when not supplied, so every pre-existing
	 * call site keeps taking the column default (`'analyze'`) byte-identically.
	 */
	kind?: string;
	// Classification pre-state (S-03 override-guard tests).
	category?: string | null;
	categoryOverridden?: boolean;
	projectId?: string | null;
	projectOverridden?: boolean;
}): Promise<{ conversationId: string; jobId: string }> {
	convSeq += 1;
	const conversationId = `conv-${convSeq}`;
	const jobId = `job-${convSeq}`;
	await db.insert(conversations).values({
		id: conversationId,
		userId: "me",
		callSid: `CA_${convSeq}`,
		recordingSid:
			opts.recordingSid === undefined ? `RE_${convSeq}` : opts.recordingSid,
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
		attemptCount: opts.attemptCount ?? 0,
		nextRetryAt: opts.nextRetryAt ?? null,
		...(opts.kind ? { kind: opts.kind } : {}),
	});
	return { conversationId, jobId };
}

let projSeq = 0;

/** Seed a project owned by `me`; returns its id (pattern from projects.test.ts). */
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

// Raw-SQL read helpers (assert against the physical columns the worker writes).
async function jobRow(jobId: string) {
	const r = await client.execute({
		sql: 'SELECT status, attempt_count, next_retry_at, last_error, last_error_code FROM "memo-call_processing_jobs" WHERE id = ?',
		args: [jobId],
	});
	return r.rows[0];
}
async function convRow(conversationId: string) {
	const r = await client.execute({
		sql: 'SELECT transcript_language, duration_ms, analysis, recording_deleted_at, category, project_id, category_overridden, project_overridden FROM "memo-call_conversations" WHERE id = ?',
		args: [conversationId],
	});
	return r.rows[0];
}
async function tagCount(conversationId: string) {
	const r = await client.execute({
		sql: 'SELECT count(*) AS n FROM "memo-call_tags" WHERE conversation_id = ?',
		args: [conversationId],
	});
	return Number(r.rows[0]?.n ?? 0);
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

/**
 * A stub STT that mimics the *real* DeepgramSttProvider closely enough to
 * exercise the worker's stream-relay wiring (deepgram mode): it consumes the
 * `stream`-kind `AudioSource` the worker's bridge hands it, and — like the real
 * provider — surfaces `signal.reason` if the bridge aborts mid-stream (worker F3).
 * On a clean drain it returns the canned per-channel transcript.
 */
function streamConsumingStt(
	result: TranscriptResult,
): Pick<SttProvider, "transcribe"> {
	return {
		async transcribe(input) {
			const audio = input.audio;
			if (audio.kind !== "stream") {
				throw new ProviderError({
					code: "invalid_response",
					message: "expected a stream source in deepgram mode",
				});
			}
			// Mirror fetch+AbortSignal: a mid-stream bridge abort rejects with the
			// ProviderError carried on signal.reason, never a masked generic error.
			const aborted = new Promise<never>((_, reject) => {
				const surface = () => {
					const reason = audio.signal?.reason;
					reject(
						reason instanceof ProviderError
							? reason
							: new ProviderError({ code: "transport", message: "aborted" }),
					);
				};
				if (audio.signal?.aborted) surface();
				else audio.signal?.addEventListener("abort", surface);
			});
			const drain = (async () => {
				const reader = audio.open().getReader();
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
				return result;
			})();
			return Promise.race([drain, aborted]);
		},
	};
}

describe("backoff", () => {
	test("is monotonic non-decreasing and capped at 60 s", () => {
		const vals = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(backoff);
		for (let i = 1; i < vals.length; i++) {
			expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] as number);
		}
		expect(vals[0]).toBe(1000); // 2^0 * 1000
		expect(backoff(5)).toBe(32_000);
		expect(backoff(6)).toBe(60_000); // 2^6 = 64 → capped at 60
		expect(backoff(100)).toBe(60_000);
	});
});

describe("processJob — happy path", () => {
	test("a pending job reaches done with transcript + analysis + tags persisted and recording deleted", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps, tracker } = makeDeps();

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("done");
		expect(Number(job?.attempt_count)).toBe(1);

		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		expect(Number(conv?.duration_ms)).toBe(4000);
		const analysis = JSON.parse(String(conv?.analysis)) as Analysis;
		expect(analysis.summary).toBe(cannedAnalysis.summary);
		expect(await tagCount(conversationId)).toBe(2);

		// The auth'd pull was drained (mock seam) and the recording deleted + stamped.
		expect(tracker.streamCalls).toBe(1);
		expect(tracker.transcribeCalls).toBe(1);
		expect(tracker.analyzeCalls).toBe(1);
		expect(tracker.deleteCalls).toEqual(["RE_1"]);
		expect(conv?.recording_deleted_at).not.toBeNull();
	});
});

describe("processJob — claim guard", () => {
	test("a non-pending (done) job is a no-op: no re-run, no duplicate tags", async () => {
		const { conversationId, jobId } = await seedJob({ status: "pending" });
		const { deps, tracker } = makeDeps();
		await processJob(jobId, deps); // first run → done, 2 tags
		expect(await tagCount(conversationId)).toBe(2);

		// Replay: claim finds status != 'pending' → zero rows → returns immediately.
		await processJob(jobId, deps);
		expect(tracker.transcribeCalls).toBe(1); // NOT re-run
		expect(tracker.analyzeCalls).toBe(1);
		expect(await tagCount(conversationId)).toBe(2); // NOT duplicated
	});

	test("a pending kind='reanalyze' job is NOT claimed: no STT, transcript + user-edited tags intact", async () => {
		// The claim itself — not the dispatch site — must be what keeps the audio-first
		// pipeline off a re-analyze job. `jobs.replay` reaches `processJob` directly
		// (it has no `kind` predicate of its own), so without a kind-scoped claim a
		// replayed re-analyze job would re-transcribe deleted audio, overwrite the
		// user's edited transcript, and clear user-edited tags via the delete-ALL write.
		// Observable-effect assertion (repo convention, see reanalyze.test.ts): a
		// claimed job ALWAYS calls stt.transcribe, so `transcribeCalls === 0` proves
		// the claim returned zero rows.
		const { conversationId, jobId } = await seedJob({
			status: "pending",
			kind: "reanalyze",
		});
		const edited: TranscriptSegment[] = [
			{
				speaker: "Speaker A",
				text: "Poprawiona treść.",
				startMs: 0,
				endMs: 1000,
			},
		];
		await db
			.update(conversations)
			.set({ transcriptSegments: edited, transcriptLanguage: "pl-PL" })
			.where(eq(conversations.id, conversationId));
		await db.insert(tags).values({
			id: "tag-user-edited",
			userId: "me",
			conversationId,
			name: "wazne",
			isUserEdited: true,
		});

		const { deps, tracker } = makeDeps();
		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("pending"); // never claimed
		expect(tracker.transcribeCalls).toBe(0); // no re-transcription of deleted audio
		expect(await convSegments(conversationId)).toEqual(edited); // edit untouched
		expect(await tagRows(conversationId)).toEqual([
			{ name: "wazne", isUserEdited: true },
		]);
	});

	test("two concurrent processJob calls on one pending job → exactly one proceeds", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps, tracker } = makeDeps();

		await Promise.all([processJob(jobId, deps), processJob(jobId, deps)]);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("done");
		expect(Number(job?.attempt_count)).toBe(1); // claimed exactly once
		expect(tracker.transcribeCalls).toBe(1);
		expect(await tagCount(conversationId)).toBe(2);
	});
});

describe("processJob — error handling", () => {
	test("a retryable error under the cap re-enqueues with a future next_retry_at", async () => {
		const { jobId } = await seedJob({});
		const { deps } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({ code: "transport", message: "boom" });
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("pending");
		expect(job?.last_error_code).toBe("transport");
		// next_retry_at = FIXED_NOW + backoff(1) = +2s. Stored as unix seconds.
		const expected = Math.floor((FIXED_NOW.getTime() + backoff(1)) / 1000);
		expect(Number(job?.next_retry_at)).toBe(expected);
	});

	test("the MAX_ATTEMPTS-th retryable failure transitions to failed", async () => {
		// Seed at the cap-minus-one so the next claim hits attempt_count = MAX.
		const { jobId } = await seedJob({ attemptCount: MAX_ATTEMPTS - 1 });
		const { deps } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({ code: "rate_limited", message: "429" });
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(Number(job?.attempt_count)).toBe(MAX_ATTEMPTS);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("rate_limited");
	});

	test("a non-retryable error (auth) fails fast with a single attempt burn", async () => {
		const { jobId } = await seedJob({});
		const { deps } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({ code: "auth", message: "nope" });
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(Number(job?.attempt_count)).toBe(1);
		expect(job?.last_error_code).toBe("auth");
	});

	test("a dead-lettered job durably persists BOTH last_error (message) and last_error_code (discriminator) (Phase 4, risk #3)", async () => {
		// Risk #3 (test-plan §3 Phase 1). FR-006's "failed jobs są visible, nie ciche"
		// promise needs a durable, human-readable REASON, not just the machine code: a
		// future panel / in-app notification binds to `last_error`. Today every failed-path
		// test asserts only `last_error_code`; the message seam is pinned nowhere. Here we
		// drive a non-retryable failure and assert the message is persisted verbatim
		// alongside the code. The expected message is the thrown one (the worker stores
		// errorMessage(err), i.e. `safeErrorMessage` — redacted and capped at 200 chars,
		// which leaves this short digit-free message verbatim), derived from the
		// contract, not a worker mirror.
		const message = "401 from provider";
		const { jobId } = await seedJob({});
		const { deps } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({ code: "auth", message });
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("auth"); // discriminator
		expect(job?.last_error).toBe(message); // human-readable reason, persisted verbatim
		expect(String(job?.last_error ?? "").length).toBeGreaterThan(0); // never an empty reason
	});

	test("invalid_response fails fast (non-retryable) AND backstops the transcript", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			analyze: async (): Promise<Analysis> => {
				throw new ProviderError({
					code: "invalid_response",
					message: "bad json",
				});
			},
		});

		await processJob(jobId, deps);
		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("invalid_response");
		// Phase 3 backstop: the transcript was persisted before analyze() ran, so a
		// dead-lettered job still shows its transcript; analysis stays NULL.
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		expect(conv?.analysis).toBeNull();
		expect((await convSegments(conversationId)).length).toBe(2);
	});
});

describe("processJob — refusal disposition + transcript backstop (Phase 3)", () => {
	// A graceful model decline (ProviderError code "refusal") is non-retryable and
	// lands the terminal `failed` status WITH the transcript preserved — never a
	// perpetual "Przetwarzanie…" (deriveStatus keys terminality on the `failed` job
	// status, not analysis presence), never retried, never silently lost.

	test("a refusal from analyze() lands terminal failed (not retried), transcript preserved", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps, tracker } = makeDeps({
			analyze: async (): Promise<Analysis> => {
				throw new ProviderError({
					code: "refusal",
					message: "stop_reason=refusal",
				});
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed"); // terminal, NOT pending
		expect(job?.last_error_code).toBe("refusal");
		expect(Number(job?.attempt_count)).toBe(1); // non-retryable → single burn, not re-enqueued
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL"); // transcript preserved
		expect(conv?.analysis).toBeNull();
		expect((await convSegments(conversationId)).length).toBe(2);
		expect(tracker.classifyCalls).toBe(0); // analyze refused → classify never reached
	});

	test("a refusal from classify() also lands terminal failed (F2: NOT absorbed into no_auto_assignment), transcript preserved", async () => {
		await seedProject("praca");
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			classify: async () => {
				throw new ProviderError({
					code: "refusal",
					message: "stop_reason=refusal",
				});
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed"); // NOT done/no_auto_assignment
		expect(job?.last_error_code).toBe("refusal");
		expect(Number(job?.attempt_count)).toBe(1);
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		expect(conv?.analysis).toBeNull();
	});

	test("a retryable transport error also backstops the transcript before re-enqueue", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			analyze: async (): Promise<Analysis> => {
				throw new ProviderError({ code: "transport", message: "boom" });
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("pending"); // retryable → re-enqueued
		// The backstop ran before analyze threw, so the transcript is already durable;
		// the retry re-runs and idempotently overwrites it.
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		expect(conv?.analysis).toBeNull();
	});
});

describe("processJob — empty / one-sided STT", () => {
	// Risk #1 (test-plan §3 Phase 1). Oracle settled in frame.md: a true-empty STT
	// result (the provider throws) dead-letters loudly; a voicemail / one-sided call
	// (≥1 non-empty segment) is PROCESSED AND KEPT — never gated. There is NO
	// structural content-gate in the worker: every available signal (channel count,
	// duration, word count, confidence) was proven ambiguous or backwards.

	test("all-empty STT (provider throws invalid_response) dead-letters to failed", async () => {
		// The all-channels-empty path is the Deepgram provider throwing
		// `invalid_response` (deepgram.ts:174-179), NOT a worker content-check. We model
		// that by making `stt.transcribe` throw, and assert the worker dead-letters it.
		const { jobId } = await seedJob({});
		const { deps, tracker } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({
						code: "invalid_response",
						message: "all channels empty",
					});
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("invalid_response"); // non-retryable → dead-letter
		expect(Number(job?.attempt_count)).toBe(1); // fast-fail, single burn
		expect(tracker.analyzeCalls).toBe(0); // never handed empty input to fabricate from
	});

	test("a one-sided / voicemail call (>=1 non-empty segment) is processed and kept (done, not gated)", async () => {
		// Regression guard: the frame DECIDED voicemails are wanted data — processed &
		// loaded, NOT dead-lettered. This locks "we never discard a thin-but-real call"
		// so a future refactor can't silently start gating. Expected `done` derives from
		// the frame oracle, not from the implementation's current output.
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					return {
						segments: [
							{
								speaker: "Speaker A",
								text: "Nagraj wiadomość po sygnale.", // a voicemail greeting — thin, but real content
								startMs: 0,
								endMs: 3000,
							},
						],
						language: "pl-PL",
						durationMs: 3000,
					};
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("done"); // processed & kept — NOT failed, NOT gated
		const conv = await convRow(conversationId);
		expect(conv?.analysis).not.toBeNull(); // analysis ran normally
		expect(await tagCount(conversationId)).toBe(2); // default cannedAnalysis → 2 tags
	});

	test("an empty transcript that does NOT throw still reaches done — the worker has no content-gate", async () => {
		// Pins the "no structural content-gate — ever" invariant at the worker level: a
		// literally-empty transcript (a shape the real provider never returns — it throws
		// first) flows through analyze to `done`. Catches a future `if (segments.length
		// === 0) fail` being added to the worker (which would re-introduce the gate the
		// frame explicitly forbade).
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					return { segments: [], language: "pl-PL", durationMs: 0 };
				},
			},
		});

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect((await convRow(conversationId))?.analysis).not.toBeNull();
	});
});

describe("processJob — persist atomicity (Phase 2)", () => {
	// Risk #2 (test-plan §3 Phase 1). The persist transaction (worker.ts:376-415)
	// must be all-or-nothing: the conversation update (analysis), the tag delete, the
	// tag inserts, and the job→done flip all commit together or none do. The happy
	// path never exercises a mid-tx failure. We force a throw on the FINAL done-flip
	// — `tx.update(processingJobs)`, which is UNCONDITIONAL (it fires regardless of
	// candidateTags count, unlike an insert-trap that the empty-tag loop would skip)
	// — and assert real libsql ROLLBACKs every prior write. Real libsql is mandatory:
	// a stub db cannot model BEGIN…ROLLBACK (CLAUDE.md "Lessons" "a stub db lies about SQL").

	test("a forced throw on the done-flip rolls back the whole persist tx (re-runnable job, zero partial writes)", async () => {
		const { conversationId, jobId } = await seedJob({});
		// Pre-seed one tag: the in-tx delete-then-insert must be undone by the rollback,
		// leaving EXACTLY this pre-existing tag — proving no partial tag state survives.
		await db.insert(tags).values({
			id: "tag-preexisting",
			userId: "me",
			conversationId,
			name: "stare",
			isUserEdited: false,
		});

		// A thin Proxy over the REAL injected db: the persist tx runs for real, but the
		// final `tx.update(processingJobs)` (the done-flip) throws → libsql ROLLBACKs.
		// Target the done-flip by table identity: the conversation update is ALSO a
		// `tx.update` (and runs first), so trapping `update` blindly would fire on the
		// wrong call. We call the real `t.update(...)` as a method on `t` (not detached)
		// so drizzle's `this` binding survives — only the processingJobs call is poisoned.
		const faultyDb = new Proxy(db, {
			get(target, prop, recv) {
				if (prop !== "transaction") return Reflect.get(target, prop, recv);
				return (cb: Parameters<typeof db.transaction>[0]) =>
					target.transaction((tx) =>
						cb(
							new Proxy(tx, {
								get(t, p, r) {
									if (p !== "update") return Reflect.get(t, p, r);
									return (table: unknown) => {
										if (table === processingJobs) {
											throw new Error("forced mid-tx fault on done-flip");
										}
										return t.update(table as Parameters<typeof t.update>[0]);
									};
								},
							}) as typeof tx,
						),
					);
			},
		}) as typeof db;

		const { deps } = makeDeps({ db: faultyDb });
		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		// Re-runnable: a plain Error is non-ProviderError → non-retryable-coded →
		// failed/unknown, NOT done. A boot-sweep / replay can re-run it cleanly.
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("unknown");

		const conv = await convRow(conversationId);
		// The conversation update (analysis) inside the tx rolled back → analysis NULL.
		// (transcript_* persists via the pre-tx backstop, which is OUTSIDE the tx.)
		expect(conv?.analysis).toBeNull();

		// The in-tx delete + the 2 candidate inserts both rolled back: the pre-seeded
		// tag is restored and the candidates are gone — exactly the pre-seeded count of
		// 1, never a partial 0/2/3. "analysis without tags / done without transcript"
		// cannot occur. Expected value is the pre-seed count, not a mirror of worker.ts.
		expect(await tagCount(conversationId)).toBe(1);
	});
});

describe("processJob — tag-dedup idempotency (Phase 3)", () => {
	// Risk #4 (test-plan §3 Phase 1). Tag-dedup correctness rests 100% on app-code
	// delete-then-insert (worker.ts:400-409) — there is NO unique index to lean on.
	// We prove the dedup holds across a genuine RE-RUN of the persist tx: a re-entered
	// tx clears the prior candidates before re-inserting, so the count never multiplies
	// and pre-seeded stale tags are cleared. Real libsql is mandatory — there is no
	// unique constraint a stub could (falsely) report. Expected value `2` is
	// candidateTags.length from the cannedAnalysis oracle, not a mirror of worker.ts.

	test("a re-run yields exactly candidateTags.length tags (never a multiple); stale tags are cleared", async () => {
		const { conversationId, jobId } = await seedJob({});
		// Pre-seed 3 stale tags: the in-tx delete must clear ALL of them before the
		// 2 candidate inserts, so the first run lands exactly 2 (not 5).
		for (const n of ["stara-1", "stara-2", "stara-3"]) {
			await db.insert(tags).values({
				id: `tag-${n}`,
				userId: "me",
				conversationId,
				name: n,
				isUserEdited: false,
			});
		}

		const { deps } = makeDeps(); // default cannedAnalysis → 2 candidateTags
		await processJob(jobId, deps);
		expect((await jobRow(jobId))?.status).toBe("done");
		// 3 stale gone, 2 inserted — delete-then-insert cleared the pre-seeded tags.
		expect(await tagCount(conversationId)).toBe(2);

		// Re-enter the persist tx via a status reset (NOT jobs.replay, NOT a no-op
		// done-replay): reset to `pending` so the claim succeeds and the tx runs again.
		await db
			.update(processingJobs)
			.set({ status: "pending" })
			.where(eq(processingJobs.id, jobId));
		await processJob(jobId, deps);

		// Still exactly 2 — the re-entered tx delete cleared the prior 2 before
		// re-inserting 2 (never 4). Idempotent dedup without a unique index.
		expect((await jobRow(jobId))?.status).toBe("done");
		expect(await tagCount(conversationId)).toBe(2);
	});

	test("first-run POLICY: the write is replace-all — a user-edited tag is CLEARED", async () => {
		// CHARACTERIZATION (Phase 4 of `refactor-opportunities`). This pins current
		// behavior as a deliberate policy, not an accident, so the Phase 5 extraction
		// into a shared reconciler cannot silently unify it with the merge policy.
		// Its twin lives in reanalyze.test.ts ("merge POLICY: … PRESERVED") — read
		// them as a pair; the asymmetry between them IS the thing being pinned.
		//
		// Why the asymmetry is correct: this path's only callers are a first run and
		// a replay, and neither has pre-existing user-edited tags to protect. The
		// delete carries no `is_user_edited` predicate precisely because it does not
		// need one HERE. (It needed one on the re-analyze path, which is why that
		// path has its own implementation — and why replaying a reanalyze job through
		// this worker was a data-loss bug until Phase 1 closed it.)
		const { conversationId, jobId } = await seedJob({});
		await db.insert(tags).values({
			id: "tag-user-edited-firstrun",
			userId: "me",
			conversationId,
			name: "recznie-dodany",
			isUserEdited: true,
		});

		const { deps } = makeDeps(); // cannedAnalysis → candidateTags powitanie, follow-up
		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		// The user-edited row is GONE; only the two normalized candidates remain.
		expect(await tagRows(conversationId)).toEqual([
			{ name: "follow-up", isUserEdited: false },
			{ name: "powitanie", isUserEdited: false },
		]);
	});
});

describe("processJob — recording delete is best-effort", () => {
	test("a delete failure does NOT flip a done job to failed", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			telephony: {
				recordingContentType: "audio/wav",
				async streamRecording(_i, sink) {
					await sink.close();
				},
				async deleteRecording() {
					throw new ProviderError({
						code: "transport",
						message: "delete down",
					});
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("done"); // delete failure is non-fatal
		const conv = await convRow(conversationId);
		expect(conv?.recording_deleted_at).toBeNull(); // not stamped → sweep retries
	});

	test("a job with no recordingSid skips the pull + delete entirely", async () => {
		const { jobId } = await seedJob({ recordingSid: null });
		const { deps, tracker } = makeDeps();

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(tracker.streamCalls).toBe(0);
		expect(tracker.deleteCalls).toEqual([]);
	});
});

describe("processJob — real mock STT seam", () => {
	test("mock mode feeds mock://long → the canned transcript and persists tags", async () => {
		const { conversationId, jobId } = await seedJob({});
		// Use the real MockSttProvider to prove the mock:// seam end-to-end.
		const { MockSttProvider } = await import("~/server/stt/mock");
		const { deps } = makeDeps({ stt: new MockSttProvider() });

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		// mock://long → 12 segments → analyze() ran → tags persisted (mock analysis).
		expect(await tagCount(conversationId)).toBeGreaterThan(0);
	});
});

describe("processJob — auto-classification (S-03)", () => {
	// Wiring assertions only — the FR-005 retry-with-feedback loop is owned by
	// classify.test.ts. Here we prove what the WORKER does with each ClassifyResult.

	test("a classified result writes category + project_id and reaches done", async () => {
		const projectId = await seedProject("praca");
		const { conversationId, jobId } = await seedJob({});
		const { deps, tracker } = makeDeps(); // default stub files into projects[0]

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		const conv = await convRow(conversationId);
		expect(conv?.category).toBe("praca");
		expect(conv?.project_id).toBe(projectId);
		// Auto-assigned on first run — NOT user-owned, both flags stay false.
		expect(Number(conv?.category_overridden)).toBe(0);
		expect(Number(conv?.project_overridden)).toBe(0);
		expect(tracker.classifyCalls).toBe(1);
	});

	test("no_auto_assignment leaves category/project NULL and still reaches done (NOT failed)", async () => {
		// Oracle (FR-005): constraint exhaustion is an explicit no-assignment outcome,
		// not a pipeline failure. Goes red if the worker flips this job to `failed`.
		await seedProject("praca");
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			classify: async () => ({ status: "no_auto_assignment", attempts: 3 }),
		});

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		const conv = await convRow(conversationId);
		expect(conv?.category).toBeNull();
		expect(conv?.project_id).toBeNull();
	});

	test("an empty project list short-circuits: classify is never called, columns stay NULL, job is done", async () => {
		const { conversationId, jobId } = await seedJob({}); // no projects seeded
		const { deps, tracker } = makeDeps();

		await processJob(jobId, deps);

		expect(tracker.classifyCalls).toBe(0); // short-circuited before the LLM
		expect((await jobRow(jobId))?.status).toBe("done");
		const conv = await convRow(conversationId);
		expect(conv?.category).toBeNull();
		expect(conv?.project_id).toBeNull();
	});

	test("a transport ProviderError from classify re-enqueues (pending) — retryable", async () => {
		await seedProject("praca");
		const { jobId } = await seedJob({});
		const { deps } = makeDeps({
			classify: async () => {
				throw new ProviderError({ code: "transport", message: "boom" });
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("pending");
		expect(job?.last_error_code).toBe("transport");
	});

	test("an auth ProviderError from classify dead-letters (failed) — non-retryable, transcript backstopped", async () => {
		await seedProject("praca");
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			classify: async () => {
				throw new ProviderError({ code: "auth", message: "401" });
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("auth");
		expect(Number(job?.attempt_count)).toBe(1);
		// Phase 3 backstop: a classify failure still preserves the transcript (written
		// before analyze/classify). analysis is NULL — it is only persisted in the
		// done-txn, which a classify failure never reaches.
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		expect(conv?.analysis).toBeNull();
	});

	test("override guard: a user-owned conversation is not re-classified (classify skipped, values untouched)", async () => {
		// S-06 contract, dormant-but-correct at S-03: when EITHER override flag is set,
		// the worker must skip the auto pair entirely. Discriminating: the classify stub
		// returns a DIFFERENT pair, so removing the guard flips both assertions red.
		const autoProjectId = await seedProject("praca"); // what auto would pick
		const userProjectId = await seedProject("prywatne"); // the user's manual choice
		const { conversationId, jobId } = await seedJob({
			category: "prywatne",
			categoryOverridden: true,
			projectId: userProjectId,
			projectOverridden: true,
		});
		let classifyCalled = 0;
		const { deps } = makeDeps({
			classify: async () => {
				classifyCalled += 1;
				return {
					status: "classified",
					classification: { category: "praca", projectId: autoProjectId },
				};
			},
		});

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(classifyCalled).toBe(0); // guard short-circuited the LLM
		const conv = await convRow(conversationId);
		// The user's manual classification survived the run untouched.
		expect(conv?.category).toBe("prywatne");
		expect(conv?.project_id).toBe(userProjectId);
		expect(Number(conv?.category_overridden)).toBe(1);
		expect(Number(conv?.project_overridden)).toBe(1);
	});

	test("a project row with an invalid category is skipped, not dead-lettered (graceful degradation)", async () => {
		// Model a malformed row (hand-edited migration / emergency SSH INSERT) by
		// inserting a bad category directly, bypassing the validated create path. The
		// worker must skip it via safeParse, NOT throw a ZodError into the catch.
		await client.execute({
			sql: 'INSERT INTO "memo-call_projects" (id, user_id, name, category) VALUES (?, ?, ?, ?)',
			args: ["proj-bad", "me", "Zepsuty", "WAT"],
		});
		const { conversationId, jobId } = await seedJob({});
		const { deps, tracker } = makeDeps();

		await processJob(jobId, deps);

		// Only an invalid project exists → filtered out → empty valid list → short-circuit.
		expect(tracker.classifyCalls).toBe(0);
		expect((await jobRow(jobId))?.status).toBe("done"); // NOT failed
		const conv = await convRow(conversationId);
		expect(conv?.category).toBeNull();
		expect(conv?.project_id).toBeNull();
	});

	test("a valid project is still used when a sibling row has an invalid category", async () => {
		const goodId = await seedProject("praca");
		await client.execute({
			sql: 'INSERT INTO "memo-call_projects" (id, user_id, name, category) VALUES (?, ?, ?, ?)',
			args: ["proj-bad2", "me", "Zepsuty", "???"],
		});
		const { conversationId, jobId } = await seedJob({});
		let received: string[] = [];
		const { deps } = makeDeps({
			classify: async (input) => {
				received = input.projects.map((p) => p.id);
				const p = input.projects[0];
				if (!p) return { status: "no_auto_assignment", attempts: 3 };
				return {
					status: "classified",
					classification: { category: p.category, projectId: p.id },
				};
			},
		});

		await processJob(jobId, deps);

		// The bad row was filtered out; only the valid project reached classify().
		expect(received).toEqual([goodId]);
		expect((await convRow(conversationId))?.project_id).toBe(goodId);
	});
});

// --- Deepgram stream-relay path (Phase 4) ------------------------------------
// These drive `processJob` in `sttMode: "deepgram"`, so `resolveAudioSource`
// builds the real Twilio→provider TransformStream bridge. `streamRecording` is
// stubbed to emit a tiny fake WAV; the STT stub consumes the bridged stream and
// honors the abort signal exactly as the real provider does. Real libsql, real
// migrations — we assert the persisted per-channel segments + the retry/dead-letter
// outcome via raw SQL.

/** A `streamRecording` stub that writes a few bytes then closes the sink cleanly. */
async function streamFakeWav(
	_input: { recordingSid: string },
	sink: WritableStream<Uint8Array>,
): Promise<void> {
	const writer = sink.getWriter();
	await writer.write(new Uint8Array([0x52, 0x49, 0x46, 0x46])); // "RIFF"
	await writer.close();
}

describe("processJob — deepgram stream relay", () => {
	test("happy path: the bridge feeds the provider → per-channel segments persist and the job reaches done", async () => {
		const { conversationId, jobId } = await seedJob({});
		const { deps } = makeDeps({
			sttMode: "deepgram",
			telephony: {
				recordingContentType: "audio/wav",
				streamRecording: streamFakeWav,
				async deleteRecording() {
					/* noop */
				},
			},
			stt: streamConsumingStt(cannedTranscript),
		});

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		const conv = await convRow(conversationId);
		expect(conv?.transcript_language).toBe("pl-PL");
		expect(Number(conv?.duration_ms)).toBe(4000);
		// Per-channel mapping survived persistence: one stable speaker per leg.
		const segments = await convSegments(conversationId);
		expect(segments.map((s) => s.speaker)).toEqual(["Speaker A", "Speaker B"]);
		expect(segments[0]?.text).toBe("Dzień dobry.");
	});

	// The MIME type the STT upload declares comes from the telephony provider,
	// not from a literal in this layer. A deliberately non-Twilio value is the
	// only thing that can catch a re-hardcoded "audio/wav": with the real value
	// a hardcoded worker and a provider-reading worker are indistinguishable.
	test("the STT source's contentType comes from the telephony provider", async () => {
		const { jobId } = await seedJob({});
		let seenContentType: string | undefined;
		const consuming = streamConsumingStt(cannedTranscript);
		const { deps } = makeDeps({
			sttMode: "deepgram",
			telephony: {
				recordingContentType: "audio/x-provider-declared",
				streamRecording: streamFakeWav,
				async deleteRecording() {
					/* noop */
				},
			},
			stt: {
				async transcribe(input) {
					if (input.audio.kind === "stream") {
						seenContentType = input.audio.contentType;
					}
					return consuming.transcribe(input);
				},
			},
		});

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		expect(seenContentType).toBe("audio/x-provider-declared");
	});

	test("F3: a mid-stream Twilio pull failure re-enqueues as `transport` (not an `unknown` dead-letter)", async () => {
		const { jobId } = await seedJob({});
		const { deps } = makeDeps({
			sttMode: "deepgram",
			telephony: {
				recordingContentType: "audio/wav",
				// Write one chunk, then fail WITHOUT closing the sink — the worker's
				// bridge `.catch` must abort the provider with the `transport` code,
				// and no unhandled rejection may escape `resolveAudioSource`.
				async streamRecording(_input, sink) {
					const writer = sink.getWriter();
					await writer.write(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
					throw new ProviderError({
						code: "transport",
						message: "recording media stream interrupted",
					});
				},
				async deleteRecording() {
					/* noop */
				},
			},
			stt: streamConsumingStt(cannedTranscript),
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("pending"); // retryable → re-enqueued, NOT failed
		expect(job?.last_error_code).toBe("transport"); // NOT "unknown"
	});

	test("F1: a provider error while the Twilio pull is in-flight tears the pull down (no leak)", async () => {
		const { jobId } = await seedJob({});
		let pullTornDown = false;
		const { deps } = makeDeps({
			sttMode: "deepgram",
			telephony: {
				recordingContentType: "audio/wav",
				// Simulate an in-flight pull: kick off a write that backpressure-stalls
				// (nobody drains the readable), and stay pending until the signal aborts
				// — exactly how the real `pipeTo(sink, {signal})` behaves. The abort
				// listener is registered BEFORE awaiting so a backpressured write can't
				// hide the teardown signal.
				async streamRecording(_input, sink, opts) {
					const writer = sink.getWriter();
					void writer.write(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
					await new Promise<void>((_resolve, reject) => {
						opts?.signal?.addEventListener(
							"abort",
							() => {
								pullTornDown = true;
								reject(opts.signal?.reason);
							},
							{ once: true },
						);
					});
				},
				async deleteRecording() {
					/* noop */
				},
			},
			stt: {
				// Provider rejects (HTTP rate_limited) WHILE the pull is still writing —
				// the F1 scenario the un-awaited bridge used to leak on.
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({ code: "rate_limited", message: "429" });
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("pending"); // rate_limited is retryable
		expect(job?.last_error_code).toBe("rate_limited");
		expect(pullTornDown).toBe(true); // cleanup() aborted the in-flight pull
	});

	test("a provider `auth` failure dead-letters fast in deepgram mode", async () => {
		const { jobId } = await seedJob({});
		const { deps } = makeDeps({
			sttMode: "deepgram",
			telephony: {
				recordingContentType: "audio/wav",
				streamRecording: streamFakeWav,
				async deleteRecording() {
					/* noop */
				},
			},
			stt: {
				async transcribe(): Promise<TranscriptResult> {
					throw new ProviderError({ code: "auth", message: "401" });
				},
			},
		});

		await processJob(jobId, deps);

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.last_error_code).toBe("auth");
		expect(Number(job?.attempt_count)).toBe(1);
	});
});

describe("kickoff — last-resort catch is status-scoped", () => {
	// Gap N-2 (Phase 6 of `refactor-opportunities`). `kickoff` is fire-and-forget:
	// `processJob` handles its own pipeline errors, so this catch fires only when
	// the claim SQL ITSELF throws. Its write is deliberately scoped to the two
	// statuses this attempt could still own (`transcribing`/`analyzing`) so it can
	// never clobber a row that has since been re-enqueued or succeeded — that
	// scoping was untested until now, and it is the kind of guard that silently
	// rots.

	/**
	 * A db proxy whose FIRST `update(...)` throws — the atomic claim is the only
	 * SQL that runs before the catch — and whose SECOND passes through: that second
	 * one IS the dead-letter write, so `settled` resolves once it has landed. Makes
	 * a fire-and-forget path deterministically awaitable without polling. Same
	 * Proxy-over-the-real-db technique as the rollback test above; `target.update`
	 * is called as a method on `target` so drizzle's `this` binding survives.
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
						throw new Error("claim SQL exploded");
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

	test("dead-letters a row still owned by this attempt (transcribing)", async () => {
		const { jobId } = await seedJob({ status: "transcribing" });
		const { faultyDb, settled } = makeClaimCrashDb();
		const { deps } = makeDeps({ db: faultyDb });

		kickoff(jobId, deps);
		await settled;

		const job = await jobRow(jobId);
		expect(job?.status).toBe("failed");
		expect(String(job?.last_error)).toBe("claim SQL exploded");
	});

	test("leaves a re-enqueued row alone (pending is owned by the retry, not by this attempt)", async () => {
		const { jobId } = await seedJob({ status: "pending" });
		const { faultyDb, settled } = makeClaimCrashDb();
		const { deps } = makeDeps({ db: faultyDb });

		kickoff(jobId, deps);
		await settled;

		// Still retryable — failing it here would strand a job the poller would have
		// drained. The boot sweep is the recovery net for a genuinely stuck row.
		expect((await jobRow(jobId))?.status).toBe("pending");
	});

	test("never clobbers a succeeded row (done)", async () => {
		const { jobId } = await seedJob({ status: "done" });
		const { faultyDb, settled } = makeClaimCrashDb();
		const { deps } = makeDeps({ db: faultyDb });

		kickoff(jobId, deps);
		await settled;

		expect((await jobRow(jobId))?.status).toBe("done");
	});
});

describe("processJob — tag vocabulary (phase 5)", () => {
	/** Seed a tag row on its own conversation, so counts are per-conversation. */
	async function seedTaggedConversation(names: string[]): Promise<void> {
		const { conversationId } = await seedJob({ status: "done" });
		for (const name of names) {
			await db.insert(tags).values({
				id: `tag-${conversationId}-${name}`,
				userId: "me",
				conversationId,
				name,
				isUserEdited: false,
			});
		}
	}

	test("hands analyze() the qualifying tag names of the job's user", async () => {
		// `faktury` twice (qualifies), `jednorazowy` once (does not).
		await seedTaggedConversation(["faktury", "jednorazowy"]);
		await seedTaggedConversation(["faktury"]);

		const { jobId } = await seedJob({});
		let seen: ReadonlyArray<string> | undefined;
		const { deps } = makeDeps({
			analyze: async (input) => {
				seen = input.vocabulary;
				return cannedAnalysis;
			},
		});

		await processJob(jobId, deps);

		expect((await jobRow(jobId))?.status).toBe("done");
		// The assertion is about the WHOLE list, not just membership: a vocabulary
		// padded with the one-off would be the exact failure mode the ≥2 threshold
		// exists to prevent, and `toContain` would not see it.
		expect(seen).toEqual(["faktury"]);
	});

	test("a failed vocabulary read degrades to empty — the job still reaches done", async () => {
		await seedTaggedConversation(["faktury"]);
		await seedTaggedConversation(["faktury"]);

		const { conversationId, jobId } = await seedJob({});
		let seen: ReadonlyArray<string> | undefined;
		const { deps } = makeDeps({
			// Only the tag READ fails. Everything else — including the done-txn's tag
			// WRITE through the transaction handle — runs against the real database.
			db: withFailingSelectFrom(db, tags, "SQLITE_BUSY: database is locked"),
			analyze: async (input) => {
				seen = input.vocabulary;
				return cannedAnalysis;
			},
		});

		const lines: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => {
			lines.push(String(l));
		});
		try {
			await processJob(jobId, deps);
		} finally {
			spy.mockRestore();
		}

		// A lost note is the one unacceptable outcome; a dictionary-less analysis
		// is merely worse. The job lands, with its tags written.
		expect((await jobRow(jobId))?.status).toBe("done");
		expect(seen).toEqual([]);
		expect(await tagCount(conversationId)).toBeGreaterThan(0);

		// …and the degradation is loud, or nobody would ever learn the tags stopped
		// converging.
		const reported = lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.event === "job.vocabulary_unavailable");
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ jobId, conversationId });
	});
});

describe("processJob — the counterparty never reaches a prompt (FR-025, A-5)", () => {
	// The type assertions in analyze.test.ts / classify.test.ts say the INPUT
	// has no field for a number. This is the runtime half: the real `analyze()`
	// and `classify()` services build their prompts from what the worker hands
	// them, and a provider stub reads those prompts back. Placeholder number and
	// name, chosen to be greppable.
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
				// Structural identification, as the mock does: the schema that accepts
				// the canned analysis is analyze's; the other one is classify's.
				return (
					schema.safeParse(cannedAnalysis).success
						? cannedAnalysis
						: { category: "praca", projectId }
				) as never;
			},
		};
		return { provider, prompts };
	}

	test("a known conversation with a number and a hint: both prompts carry the transcript, neither carries the number or the hint", async () => {
		const projectId = await seedProject("praca");
		const { conversationId, jobId } = await seedJob({});
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

		await processJob(jobId, deps);

		// Positive controls first: the job landed, BOTH services ran, and the
		// prompts carry what they are supposed to — otherwise the absence checks
		// below would be green over two empty strings.
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
