/**
 * Worker startup hook (Phase 4 of `call-to-analysis-pipeline`).
 *
 * Next.js calls `register()` exactly once per server process at boot. We start
 * the durable job worker here — but only in the Node.js runtime (the worker
 * imports libsql + the provider singletons, which the edge runtime can't load),
 * and only once even across HMR (the `globalThis` flag). The boot sweep runs
 * BEFORE the poller so a job interrupted by a crash/deploy is re-queued, not
 * double-processed.
 *
 * The worker modules are loaded via dynamic `import()` AFTER the runtime guard so
 * the Node-only code (top-level `await` in `db/index.ts`, the `twilio` SDK) is
 * never pulled into an edge bundle. `instrumentation.ts` is a first-class graph
 * hook, so Next.js includes it in the standalone output without any
 * `outputFileTracingIncludes` entry.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const g = globalThis as unknown as { __memoWorkerStarted?: boolean };
	if (g.__memoWorkerStarted) return;
	g.__memoWorkerStarted = true;

	const { defaultWorkerDeps } = await import("~/server/jobs/worker");
	const { runBootSweep, startPoller } = await import("~/server/jobs/scheduler");

	const deps = defaultWorkerDeps();
	const requeued = await runBootSweep(deps);
	console.error(
		JSON.stringify({
			event: "worker.boot",
			ts: new Date().toISOString(),
			requeued,
		}),
	);
	startPoller(deps);
}
