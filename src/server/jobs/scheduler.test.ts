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
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import {
	conversations,
	processingJobs,
	reconcileTombstones,
} from "~/server/db/schema";
import {
	pollOnce,
	RECONCILE_GRACE_MS,
	RECONCILE_LOG_BUDGET,
	RECONCILE_SWEEP_EVERY_N_TICKS,
	RECONCILE_WINDOW_MS,
	runBootSweep,
	runDeleteSweep,
	runReconcileSweep,
	startPoller,
} from "~/server/jobs/scheduler";
import type { WorkerDeps } from "~/server/jobs/worker";
import type { Analysis } from "~/server/llm/schemas";
import type { TranscriptResult } from "~/server/stt/types";
import { MockTelephonyProvider } from "~/server/telephony/mock";
import type { PendingRecording } from "~/server/telephony/types";
import { handleRecordingStatus } from "~/server/telephony/webhooks";

const DB_PATH = makeIntegrationDbPath("scheduler");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

const FIXED_NOW = new Date("2026-06-10T12:00:00.000Z");

const cannedTranscript: TranscriptResult = {
	segments: [{ speaker: "A", text: "Cześć.", startMs: 0, endMs: 1000 }],
	language: "pl-PL",
	durationMs: 1000,
};
const cannedAnalysis: Analysis = {
	summary: "x",
	keyInsights: [],
	decisions: [],
	actionItems: [],
	candidateTags: ["t"],
};

type Tracker = { processed: string[]; deleted: string[] };

function makeDeps(over: Partial<WorkerDeps> = {}): {
	deps: WorkerDeps;
	tracker: Tracker;
} {
	const tracker: Tracker = { processed: [], deleted: [] };
	const deps: WorkerDeps = {
		db,
		telephony: {
			recordingContentType: "audio/wav",
			async streamRecording(_i, sink) {
				await sink.close();
			},
			async deleteRecording(input) {
				tracker.deleted.push(input.recordingSid);
			},
		},
		stt: {
			async transcribe() {
				return cannedTranscript;
			},
		},
		analyze: async () => cannedAnalysis,
		// No projects are seeded in scheduler tests, so the worker short-circuits
		// before this is ever called; present only to satisfy WorkerDeps.
		classify: async () => ({ status: "no_auto_assignment", attempts: 3 }),
		sttMode: "mock",
		userId: "me",
		now: () => FIXED_NOW,
		...over,
	};
	return { deps, tracker };
}

let seq = 0;
async function seedJob(opts: {
	status?: string;
	createdAt?: Date;
	nextRetryAt?: Date | null;
	recordingSid?: string | null;
	recordingDeletedAt?: Date | null;
	/**
	 * Job kind. Omitted from the INSERT when not supplied, so every pre-existing
	 * call site keeps taking the column default (`'analyze'`) byte-identically.
	 */
	kind?: string;
}): Promise<{ conversationId: string; jobId: string }> {
	seq += 1;
	const conversationId = `c-${seq}`;
	const jobId = `j-${seq}`;
	await db.insert(conversations).values({
		id: conversationId,
		userId: "me",
		callSid: `CA_${seq}`,
		recordingSid:
			opts.recordingSid === undefined ? `RE_${seq}` : opts.recordingSid,
		recordingDeletedAt: opts.recordingDeletedAt ?? null,
	});
	await db.insert(processingJobs).values({
		id: jobId,
		userId: "me",
		conversationId,
		status: opts.status ?? "pending",
		nextRetryAt: opts.nextRetryAt ?? null,
		...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
		...(opts.kind ? { kind: opts.kind } : {}),
	});
	return { conversationId, jobId };
}

async function jobStatus(jobId: string) {
	const r = await client.execute({
		sql: 'SELECT status FROM "memo-call_processing_jobs" WHERE id = ?',
		args: [jobId],
	});
	return r.rows[0]?.status;
}
async function recordingDeletedAt(conversationId: string) {
	const r = await client.execute({
		sql: 'SELECT recording_deleted_at FROM "memo-call_conversations" WHERE id = ?',
		args: [conversationId],
	});
	return r.rows[0]?.recording_deleted_at;
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
	await client.execute('DELETE FROM "memo-call_reconcile_tombstones"');
	await client.execute('DELETE FROM "memo-call_tags"');
	await client.execute('DELETE FROM "memo-call_processing_jobs"');
	await client.execute('DELETE FROM "memo-call_conversations"');
});

describe("runBootSweep", () => {
	test("re-queues interrupted (transcribing/analyzing) jobs and leaves others", async () => {
		const { jobId: t } = await seedJob({ status: "transcribing" });
		const { jobId: a } = await seedJob({ status: "analyzing" });
		const { jobId: done } = await seedJob({ status: "done" });
		const { jobId: failed } = await seedJob({ status: "failed" });

		const { deps } = makeDeps();
		const requeued = await runBootSweep(deps);

		expect(requeued).toBe(2);
		expect(await jobStatus(t)).toBe("pending");
		expect(await jobStatus(a)).toBe("pending");
		expect(await jobStatus(done)).toBe("done");
		expect(await jobStatus(failed)).toBe("failed");
	});

	test("emits a census line for a pending job no pipeline can dispatch", async () => {
		// The companion to the poller's head-of-line guard: skipping such a row keeps
		// the queue alive, but silence would make it invisible forever (it is skipped
		// by every tick and touched by nothing). Boot is the right cadence — the row
		// cannot appear without someone editing the DB directly.
		const { jobId: poison } = await seedJob({ kind: "summarize" });
		await seedJob({}); // a normal pending job must NOT be reported

		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "error")
			.mockImplementation((line: unknown) => {
				lines.push(String(line));
			});
		try {
			const { deps } = makeDeps();
			await runBootSweep(deps);
		} finally {
			spy.mockRestore();
		}

		const reported = lines
			.map((l) => JSON.parse(l) as { event: string; jobId: string })
			.filter((l) => l.event === "job.unknown_kind_skipped");
		expect(reported.map((l) => l.jobId)).toEqual([poison]);
	});
});

describe("pollOnce", () => {
	test("claims and processes the oldest due pending job to done", async () => {
		const older = await seedJob({
			createdAt: new Date("2026-06-10T11:00:00.000Z"),
		});
		await seedJob({ createdAt: new Date("2026-06-10T11:30:00.000Z") });

		const { deps } = makeDeps();
		await pollOnce(deps);

		// The oldest job advanced; the newer one is still pending.
		expect(await jobStatus(older.jobId)).toBe("done");
	});

	test("skips a pending job whose next_retry_at is in the future", async () => {
		const future = new Date(FIXED_NOW.getTime() + 60_000);
		const { jobId } = await seedJob({ nextRetryAt: future });

		const { deps } = makeDeps();
		await pollOnce(deps);

		expect(await jobStatus(jobId)).toBe("pending"); // not yet due
	});

	test("processes a pending job whose next_retry_at is in the past", async () => {
		const past = new Date(FIXED_NOW.getTime() - 1000);
		const { jobId } = await seedJob({ nextRetryAt: past });

		const { deps } = makeDeps();
		await pollOnce(deps);

		expect(await jobStatus(jobId)).toBe("done");
	});

	test("is a no-op when nothing is claimable", async () => {
		await seedJob({ status: "done" });
		const { deps } = makeDeps();
		await expect(pollOnce(deps)).resolves.toBeUndefined();
	});

	test("an un-dispatchable kind does NOT block the queue behind it (head-of-line guard)", async () => {
		// Since both claims are kind-scoped, a row whose `kind` matches no pipeline is
		// claimable by nobody. Without the `kind IN (…)` predicate the oldest-first
		// `limit(1)` select would return that same row on every tick FOREVER and no
		// job would ever be processed again — a silent, total outage. Seed the poison
		// row OLDER than a healthy one so it wins the ordering and would be picked
		// first; the healthy job reaching `done` is the proof it was skipped.
		//
		// Such a row is only reachable via a hand-edited migration or the documented
		// emergency `fly ssh` INSERT — the app writes only the column default or
		// `'reanalyze'`. This is a survivability guard, not a routine path.
		const { jobId: poison } = await seedJob({
			kind: "summarize",
			createdAt: new Date("2026-06-10T10:00:00.000Z"),
		});
		const { jobId: healthy } = await seedJob({
			createdAt: new Date("2026-06-10T11:00:00.000Z"),
		});

		const { deps } = makeDeps();
		await pollOnce(deps);

		expect(await jobStatus(healthy)).toBe("done"); // queue kept draining
		expect(await jobStatus(poison)).toBe("pending"); // inert, not consumed
	});

	test("leaves a stuck transcribing/analyzing job UNTOUCHED — recovery is the boot-sweep's job, not the poller's (Phase 3, risk #4)", async () => {
		// pollOnce selects only status='pending' (scheduler.ts:57-72); non-terminal
		// recovery belongs to runBootSweep, which runs at boot when no worker can race
		// the atomic claim. This is the exact complement of the runBootSweep test above:
		// it pins that the LIVE poller never sweeps in-flight rows (which would race the
		// claim). A future "fix" that makes pollOnce rescue non-terminal rows goes red here.
		const { jobId: transcribing } = await seedJob({ status: "transcribing" });
		const { jobId: analyzing } = await seedJob({ status: "analyzing" });

		const { deps } = makeDeps();
		await pollOnce(deps); // no boot-sweep run

		expect(await jobStatus(transcribing)).toBe("transcribing"); // untouched
		expect(await jobStatus(analyzing)).toBe("analyzing"); // untouched
	});
});

describe("runDeleteSweep", () => {
	test("deletes + stamps recordings for done jobs with a resident recording", async () => {
		const { conversationId } = await seedJob({ status: "done" });

		const { deps, tracker } = makeDeps();
		await runDeleteSweep(deps);

		expect(tracker.deleted).toEqual([conversationId.replace("c-", "RE_")]);
		expect(await recordingDeletedAt(conversationId)).not.toBeNull();
	});

	test("ignores recordings already deleted or jobs not yet done", async () => {
		// already stamped → skip
		await seedJob({ status: "done", recordingDeletedAt: FIXED_NOW });
		// job still pending → its recording is not safe to delete yet
		await seedJob({ status: "pending" });

		const { deps, tracker } = makeDeps();
		await runDeleteSweep(deps);

		expect(tracker.deleted).toEqual([]);
	});

	test("a provider delete failure leaves the stamp null (retried next tick)", async () => {
		const { conversationId } = await seedJob({ status: "done" });
		const { deps } = makeDeps({
			telephony: {
				recordingContentType: "audio/wav",
				async streamRecording(_i, sink) {
					await sink.close();
				},
				async deleteRecording() {
					throw new Error("provider down");
				},
			},
		});

		await runDeleteSweep(deps);
		expect(await recordingDeletedAt(conversationId)).toBeNull();
	});
});

/**
 * Capture reconciliation (`telephony-capture-reconciliation` phase 2).
 *
 * Real libsql throughout, per `lessons.md`: the whole point of the sweep is a
 * pair of INSERTs guarded by a partial-unique index, and a stub-db test
 * structurally cannot tell you whether that SQL is valid.
 */
describe("runReconcileSweep", () => {
	/**
	 * A provider stub that behaves like the vendor on the one axis that matters
	 * here: it answers only for the window it is ASKED about.
	 *
	 * That is what makes the grace test load-bearing rather than circular. The
	 * grace lives in the window the sweep computes, so a stub that ignored
	 * `since`/`until` and returned everything would pass no matter what the sweep
	 * asked for — and the test would prove nothing about the one race
	 * (`conv_user_callsid_uq` protects against a LATE webhook, never an EARLY
	 * sweep) that the grace exists to remove.
	 */
	function listStub(rows: (PendingRecording & { at: Date })[]) {
		const windows: { since: Date; until: Date }[] = [];
		return {
			windows,
			async listRecordingsAwaitingCapture(input: {
				since: Date;
				until: Date;
			}): Promise<PendingRecording[]> {
				windows.push({ since: input.since, until: input.until });
				return rows
					.filter(
						(r) =>
							r.at.getTime() >= input.since.getTime() &&
							r.at.getTime() <= input.until.getTime(),
					)
					.map(({ at: _at, ...rest }) => rest);
			},
		};
	}

	function pendingRow(
		callSid: string,
		minutesAgo: number,
	): PendingRecording & { at: Date } {
		return {
			callSid,
			recordingSid: `${callSid}.rec`,
			at: new Date(FIXED_NOW.getTime() - minutesAgo * 60_000),
		};
	}

	/** Deps whose telephony CAN reconcile — the base stub deliberately cannot. */
	function withProvider(
		stub: ReturnType<typeof listStub>,
	): ReturnType<typeof makeDeps> {
		const { deps, tracker } = makeDeps();
		return {
			tracker,
			deps: {
				...deps,
				telephony: {
					...deps.telephony,
					listRecordingsAwaitingCapture: (input) =>
						stub.listRecordingsAwaitingCapture(input),
				},
			},
		};
	}

	function captureStderr(): { lines: string[]; restore: () => void } {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => {
			lines.push(String(l));
		});
		return { lines, restore: () => spy.mockRestore() };
	}

	function events(lines: string[], event: string) {
		return lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.event === event);
	}

	async function conversationRows() {
		const r = await client.execute(
			'SELECT id, call_sid, recording_sid, user_id FROM "memo-call_conversations"',
		);
		return r.rows;
	}
	async function jobRows() {
		const r = await client.execute(
			'SELECT id, conversation_id, status, kind FROM "memo-call_processing_jobs"',
		);
		return r.rows;
	}

	/**
	 * Full-review F10a — the ORDER of the two batch lookups is load-bearing, and
	 * before this test nothing pinned it.
	 *
	 * The sweep reads `conversations` (`known`) FIRST and `reconcile_tombstones`
	 * (`buried`) SECOND. A user delete commits both halves in ONE transaction, so
	 * this order is safe in every interleaving. Swap the two SELECTs and a window
	 * opens: `buried` read BEFORE the delete commits sees no tombstone, `known`
	 * read AFTER it sees no row, neither query knows the call — and the sweep
	 * resurrects a note the user destroyed.
	 *
	 * This drives exactly that interleaving by landing the delete BETWEEN the two
	 * reads (a `select` proxy fires it on the second call).
	 *
	 * WHAT IT ACTUALLY PINS, measured with a cross mutation matrix rather than
	 * assumed: the sweep's order and `backfillConversation`'s own tombstone read
	 * are REDUNDANT defences. Swapping the order alone still passes (the write
	 * path catches it); removing the write-path guard alone still passes (this
	 * order catches it); removing BOTH fails here with a resurrected conversation
	 * and a job. So this test is the end-to-end guard on the property, not on
	 * either mechanism — which is what makes it survive a refactor of either one
	 * while still failing if someone removes the last line of defence.
	 */
	test("known-before-buried: a delete landing BETWEEN the two reads cannot resurrect", async () => {
		await db.insert(conversations).values({
			id: "c-racy",
			userId: "me",
			callSid: "out_racy",
			recordingSid: "out_racy.rec",
		});

		// Commits the delete + its tombstone the way `conversations.delete` does:
		// one transaction, both halves.
		async function userDeletesIt() {
			await db.transaction(async (tx) => {
				await tx.delete(conversations).where(eq(conversations.id, "c-racy"));
				await tx
					.insert(reconcileTombstones)
					.values({ id: "tomb-racy", userId: "me", callSid: "out_racy" });
			});
		}

		let selects = 0;
		const racyDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop !== "select") return Reflect.get(target, prop, receiver);
				return (...args: unknown[]) => {
					selects += 1;
					const builder = (
						target.select as (...a: unknown[]) => {
							from: (t: unknown) => {
								where: (w: unknown) => PromiseLike<unknown>;
							};
						}
					)(...args);
					if (selects !== 2) return builder;
					// Second read: let the delete commit first, then run the real query.
					// A genuine Promise, not a hand-rolled thenable — same effect, and
					// it does not trip `lint/suspicious/noThenProperty`.
					return {
						from: (t: unknown) => ({
							where: async (w: unknown) => {
								await userDeletesIt();
								return builder.from(t).where(w);
							},
						}),
					};
				};
			},
		}) as typeof db;

		const stub = listStub([pendingRow("out_racy", 30)]);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep({ ...deps, db: racyDb });
		} finally {
			restore();
		}

		// Both reads happened, and the delete really landed between them.
		expect(selects).toBe(2);
		expect(await conversationRows()).toHaveLength(0);
		expect(await jobRows()).toHaveLength(0);
		const [sweep] = events(lines, "telephony.reconcile.sweep");
		expect(sweep?.backfilled).toBe(0);
	});

	test("backfills a resident recording we have no conversation for", async () => {
		const stub = listStub([pendingRow("out_missing", 30)]);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		const convs = await conversationRows();
		expect(convs).toHaveLength(1);
		expect(convs[0]?.call_sid).toBe("out_missing");
		expect(convs[0]?.recording_sid).toBe("out_missing.rec");
		// The multi-user-ready invariant: the row carries the userId it was GIVEN.
		expect(convs[0]?.user_id).toBe("me");

		const jobs = await jobRows();
		expect(jobs).toHaveLength(1);
		// The job must point at THE conversation just created — a real assertion,
		// not a tautology: `conversationRows()` selects `id` precisely so this
		// cannot collapse into `expect(x).toBe(x)` (impl-review phase 2, F2).
		expect(convs[0]?.id).toBeTruthy();
		expect(jobs[0]?.conversation_id).toBe(convs[0]?.id);
		expect(jobs[0]?.status).toBe("pending");
		// No new job kind — the recovered call runs the ordinary audio pipeline.
		expect(jobs[0]?.kind).toBe("analyze");

		const [sweep] = events(lines, "telephony.reconcile.sweep");
		expect(sweep).toMatchObject({ scanned: 1, missing: 1, backfilled: 1 });
	});

	test("skips a call we already have, and creates no second job", async () => {
		// `seedJob` lands conversation `CA_<n>` + one job for it.
		const { jobId } = await seedJob({});
		const known = await client.execute({
			sql: 'SELECT call_sid FROM "memo-call_conversations" WHERE id = (SELECT conversation_id FROM "memo-call_processing_jobs" WHERE id = ?)',
			args: [jobId],
		});
		const callSid = String(known.rows[0]?.call_sid);

		const stub = listStub([pendingRow(callSid, 30)]);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		expect(await conversationRows()).toHaveLength(1);
		expect(await jobRows()).toHaveLength(1);
		const [sweep] = events(lines, "telephony.reconcile.sweep");
		expect(sweep).toMatchObject({ scanned: 1, missing: 0, backfilled: 0 });
	});

	test("does NOT loop on a permanently-failed job whose recording is still resident", async () => {
		// The known FR-002 debt: a dead-lettered job never deletes its recording, so
		// the provider reports it as resident FOREVER. A sweep keyed on residency
		// alone would re-enqueue it every five minutes; the detector is the MISSING
		// conversation row, and this row is not missing.
		const { jobId } = await seedJob({ status: "failed" });
		const known = await client.execute({
			sql: 'SELECT call_sid FROM "memo-call_conversations" WHERE id = (SELECT conversation_id FROM "memo-call_processing_jobs" WHERE id = ?)',
			args: [jobId],
		});
		const callSid = String(known.rows[0]?.call_sid);

		const stub = listStub([pendingRow(callSid, 30)]);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		expect(await jobRows()).toHaveLength(1);
		expect(await conversationRows()).toHaveLength(1);
		const sweeps = events(lines, "telephony.reconcile.sweep");
		expect(sweeps).toHaveLength(2);
		for (const s of sweeps)
			expect(s).toMatchObject({ missing: 0, backfilled: 0 });
	});

	test("a late NOTIFY_RECORD after a backfill is absorbed, not duplicated", async () => {
		// The direction the index DOES cover: we recovered the call, then the
		// vendor's notification finally lands. It must be a no-op — one
		// conversation, one job, no second run of STT + LLM over the same audio.
		const callSid = "out_late_webhook";
		const stub = listStub([pendingRow(callSid, 30)]);
		const { deps } = withProvider(stub);

		const { restore } = captureStderr();
		try {
			await runReconcileSweep(deps);

			const res = await handleRecordingStatus(
				new Request(
					"https://your-app.fly.dev/api/telephony/recording-status",
					{
						method: "POST",
						headers: {
							"content-type": "application/x-www-form-urlencoded",
							"x-twilio-signature": "mock-valid",
						},
						body: new URLSearchParams({
							CallSid: callSid,
							RecordingSid: `${callSid}.rec`,
							RecordingStatus: "completed",
							RecordingDuration: "7",
						}).toString(),
					},
				),
				{
					telephony: new MockTelephonyProvider(),
					db,
					publicBaseUrl: "https://your-app.fly.dev",
					userId: "me",
				},
			);
			expect(res.status).toBe(200);
		} finally {
			restore();
		}

		expect(await conversationRows()).toHaveLength(1);
		expect(await jobRows()).toHaveLength(1);
	});

	test("the mandatory grace excludes a just-ended call and admits an older one", async () => {
		const stub = listStub([
			pendingRow("out_two_minutes_ago", 2),
			pendingRow("out_thirty_minutes_ago", 30),
		]);
		const { deps } = withProvider(stub);

		const { restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		const convs = await conversationRows();
		expect(convs.map((r) => r.call_sid)).toEqual(["out_thirty_minutes_ago"]);

		// And pin the window itself, so the exclusion above cannot be explained by
		// anything except the grace.
		const [window] = stub.windows;
		expect(window?.until.getTime()).toBe(
			FIXED_NOW.getTime() - RECONCILE_GRACE_MS,
		);
		expect(window?.since.getTime()).toBe(
			FIXED_NOW.getTime() - RECONCILE_GRACE_MS - RECONCILE_WINDOW_MS,
		);
	});

	test("a provider without the capability is a clean, SILENT no-op", async () => {
		// Mock + Twilio have no reconciliation. Silence is the point: a run line
		// here would make an inert sweep look like a working one in `fly logs`.
		const { deps } = makeDeps();
		expect(
			(deps.telephony as { listRecordingsAwaitingCapture?: unknown })
				.listRecordingsAwaitingCapture,
		).toBeUndefined();

		const { lines, restore } = captureStderr();
		try {
			await expect(runReconcileSweep(deps)).resolves.toBeUndefined();
		} finally {
			restore();
		}

		expect(lines).toEqual([]);
		expect(await conversationRows()).toHaveLength(0);
	});

	test("a ProviderError is logged with its code and never escapes", async () => {
		const { deps: base } = makeDeps();
		const deps: WorkerDeps = {
			...base,
			telephony: {
				...base.telephony,
				listRecordingsAwaitingCapture: async () => {
					throw new ProviderError({
						code: "transport",
						message: "zadarma unreachable",
					});
				},
			},
		};

		const { lines, restore } = captureStderr();
		try {
			await expect(runReconcileSweep(deps)).resolves.toBeUndefined();
		} finally {
			restore();
		}

		const [failed] = events(lines, "telephony.reconcile.failed");
		expect(failed).toMatchObject({
			errorCode: "transport",
			error: "zadarma unreachable",
		});
		// A failed provider call reports NOTHING as a run — a sweep that could not
		// ask must not read as a sweep that asked and found nothing.
		expect(events(lines, "telephony.reconcile.sweep")).toHaveLength(0);
	});

	test("a per-row write failure does not abandon the rest of the batch", async () => {
		const stub = listStub([
			pendingRow("out_row_a", 30),
			pendingRow("out_row_b", 30),
		]);
		const { deps: withList } = withProvider(stub);
		let calls = 0;
		// A Proxy, not a spread: the drizzle db is a class instance, so spreading it
		// drops every method onto the floor (`db.select is not a function`).
		const db = new Proxy(withList.db, {
			get(target, prop, receiver) {
				if (prop === "transaction") {
					return async (fn: Parameters<typeof target.transaction>[0]) => {
						calls += 1;
						if (calls === 1) throw new Error("write failed");
						return target.transaction(fn);
					};
				}
				const value = Reflect.get(target, prop, receiver) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const deps: WorkerDeps = { ...withList, db };

		const { lines, restore } = captureStderr();
		try {
			await expect(runReconcileSweep(deps)).resolves.toBeUndefined();
		} finally {
			restore();
		}

		expect(await conversationRows()).toHaveLength(1);
		const [failed] = events(lines, "telephony.reconcile.failed");
		expect(failed).toMatchObject({ callSid: "out_row_a" });
		const [sweep] = events(lines, "telephony.reconcile.sweep");
		expect(sweep).toMatchObject({ scanned: 2, missing: 2, backfilled: 1 });
	});

	test("NEVER resurrects a conversation the user deleted (tombstone)", async () => {
		// impl-review phase 2, F1 — the one failure mode this sweep can cause on
		// its own. A deleted conversation whose provider-side recording delete
		// failed is a resident recording with NO row: exactly the shape the
		// detector backfills. The tombstone is what still answers "we knew about
		// this call" after the row is gone. Two sweeps, because the resurrection
		// would otherwise repeat on every tick forever.
		const callSid = "out_user_deleted";
		await client.execute({
			sql: 'INSERT INTO "memo-call_reconcile_tombstones" (id, user_id, call_sid) VALUES (?, ?, ?)',
			args: ["tomb-1", "me", callSid],
		});

		const stub = listStub([pendingRow(callSid, 30)]);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		expect(await conversationRows()).toHaveLength(0);
		expect(await jobRows()).toHaveLength(0);
		const sweeps = events(lines, "telephony.reconcile.sweep");
		expect(sweeps).toHaveLength(2);
		for (const sw of sweeps)
			expect(sw).toMatchObject({ scanned: 1, missing: 0, backfilled: 0 });
	});

	test("a tombstone for ANOTHER user does not shield this user's call", async () => {
		// The lookup is user-scoped like every other query (multi-user-ready
		// invariant), so a foreign tombstone must not suppress a real backfill.
		const callSid = "out_foreign_tombstone";
		await client.execute({
			sql: 'INSERT INTO "memo-call_users" (id) VALUES (?) ON CONFLICT DO NOTHING',
			args: ["other"],
		});
		await client.execute({
			sql: 'INSERT INTO "memo-call_reconcile_tombstones" (id, user_id, call_sid) VALUES (?, ?, ?)',
			args: ["tomb-2", "other", callSid],
		});

		const stub = listStub([pendingRow(callSid, 30)]);
		const { deps } = withProvider(stub);

		const { restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		expect(await conversationRows()).toHaveLength(1);
	});

	test("a row with a blank callSid is counted as malformed, never written", async () => {
		// impl-review F6. A blank `call_sid` is NOT NULL as far as the partial
		// unique index is concerned, so writing one would collapse every such call
		// onto a single conversation. The Zadarma mapper makes this unreachable
		// today; the contract does not, and this is the write path.
		const rows = [pendingRow("out_good", 30), pendingRow("", 30)];
		const stub = listStub(rows);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		const convs = await conversationRows();
		expect(convs.map((r) => r.call_sid)).toEqual(["out_good"]);
		const [sweep] = events(lines, "telephony.reconcile.sweep");
		expect(sweep).toMatchObject({ scanned: 2, malformed: 1, backfilled: 1 });
	});

	test("per-row log lines are budgeted; the overflow is counted, not printed", async () => {
		// impl-review F4. These lines share Fly's ~7-day window with the auth and
		// job audit trails, which have no other home, and a permanently-failing
		// write repeats every run — so the budget is a control, not tidiness.
		const many = Array.from({ length: RECONCILE_LOG_BUDGET + 5 }, (_, i) =>
			pendingRow(`out_bulk_${i}`, 30),
		);
		const stub = listStub(many);
		const { deps } = withProvider(stub);

		const { lines, restore } = captureStderr();
		try {
			await runReconcileSweep(deps);
		} finally {
			restore();
		}

		// Every row still landed in the DB — the budget caps LOGGING, never work.
		expect(await conversationRows()).toHaveLength(RECONCILE_LOG_BUDGET + 5);
		expect(events(lines, "telephony.reconcile.backfilled")).toHaveLength(
			RECONCILE_LOG_BUDGET,
		);
		const [sweep] = events(lines, "telephony.reconcile.sweep");
		expect(sweep).toMatchObject({
			backfilled: RECONCILE_LOG_BUDGET + 5,
			suppressed: 5,
		});
	});

	test("a database failure is reported AS a reconcile failure, not as a generic tick error", async () => {
		// impl-review F7. Before the outer try this escaped into the tick and
		// surfaced as `job.poll_tick_failed` with no mention of reconciliation and
		// no run line — silence in the subsystem that exists to abolish silences.
		const stub = listStub([pendingRow("out_db_down", 30)]);
		const { deps: withList } = withProvider(stub);
		const db = new Proxy(withList.db, {
			get(target, prop, receiver) {
				if (prop === "select") {
					return () => {
						throw new Error("libsql exploded");
					};
				}
				const value = Reflect.get(target, prop, receiver) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const deps: WorkerDeps = { ...withList, db };

		const { lines, restore } = captureStderr();
		try {
			await expect(runReconcileSweep(deps)).resolves.toBeUndefined();
		} finally {
			restore();
		}

		const [failed] = events(lines, "telephony.reconcile.failed");
		expect(failed).toMatchObject({ error: "libsql exploded" });
		expect(events(lines, "telephony.reconcile.sweep")).toHaveLength(0);
	});

	test("the sweep runs inside a poller tick and a provider failure cannot kill it", async () => {
		// The cadence + containment claim, driven through the real `startPoller`
		// rather than by calling the sweep directly: `RECONCILE_SWEEP_EVERY_N_TICKS`
		// ticks must produce exactly one sweep attempt, and its failure must not
		// take the interval down with it.
		const { deps: base } = makeDeps();
		let asked = 0;
		const deps: WorkerDeps = {
			...base,
			telephony: {
				...base.telephony,
				listRecordingsAwaitingCapture: async () => {
					asked += 1;
					throw new ProviderError({ code: "transport", message: "down" });
				},
			},
		};

		const { lines, restore } = captureStderr();
		vi.useFakeTimers();
		let stop: (() => void) | undefined;
		try {
			stop = startPoller(deps, 1);
			await vi.advanceTimersByTimeAsync(RECONCILE_SWEEP_EVERY_N_TICKS);
		} finally {
			stop?.();
			vi.useRealTimers();
			restore();
		}

		expect(asked).toBe(1);
		expect(events(lines, "telephony.reconcile.failed")).toHaveLength(1);
		// The tick's own catch never fired — the sweep swallowed its error itself.
		expect(events(lines, "job.poll_tick_failed")).toHaveLength(0);
	});
});
