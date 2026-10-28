import { env } from "~/env";
import { handleRecordingStatus } from "~/server/telephony/webhooks";

// Recording-status callback: the per-call callback URL a provider is TOLD (Twilio
// puts it in the TwiML we generate). A provider with one account-level
// notification URL instead posts to `../events`, which re-exports this module's
// POST so both ingresses wire identical deps.
//
// Raw Route Handler (providers post form-encoded, not JSON), Node runtime (the
// vendor SDKs use Buffer/crypto), signature-as-auth. `userId` is the hardcoded
// single-user constant `'me'` (same value as the tRPC context) — the provider is
// unauthenticated, so there is no session to resolve it from.
export const runtime = "nodejs";

/**
 * The adapters are resolved at REQUEST time, not import time.
 *
 * Not a cost optimization — a side-effect one. Importing `~/server/db` runs a
 * top-level `await client.execute("PRAGMA foreign_keys = ON;")` (opening a libsql
 * connection) and `~/server/telephony` constructs the provider singleton at module
 * load; `~/server/jobs/worker` statically pulls the same db singleton. With static
 * imports, merely IMPORTING this module — as a test must — opened a connection and
 * built a provider, which is why the product's ingress had zero tests while the
 * handler one layer down (`webhooks.ts`) has two suites.
 *
 * `~/env` and `~/server/telephony/webhooks` stay static: pure modules, no
 * connection or provider construction at load. Same pattern (and same two causes)
 * as `src/instrumentation.ts`. Node caches the resolved modules, so this is a
 * one-time cost on the first webhook after a deploy — and the instrumentation boot
 * hook has usually already warmed them.
 */
export async function POST(request: Request): Promise<Response> {
	const { db } = await import("~/server/db");
	const { telephony } = await import("~/server/telephony");
	const { defaultWorkerDeps, kickoff } = await import("~/server/jobs/worker");

	// The kickoff is the Phase 4 fast-path; the instrumentation poller drains the
	// same job if this misses.
	const workerDeps = defaultWorkerDeps();

	return handleRecordingStatus(request, {
		telephony,
		db,
		publicBaseUrl: env.PUBLIC_BASE_URL,
		userId: "me",
		kickoff: (jobId) => kickoff(jobId, workerDeps),
	});
}
