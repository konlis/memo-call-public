import { describe, expect, test } from "vitest";

/**
 * Pins the property Phase 6 of `refactor-opportunities` exists to create: these
 * two route modules can be IMPORTED without side effects.
 *
 * Deliberately mock-free. The per-route wiring suites next door mock
 * `~/server/db`, so they structurally cannot observe this — they would stay green
 * if someone reintroduced a static import. This file is the only guard.
 *
 * The observable is `globalThis.client`: `~/server/db` caches the libsql client
 * there whenever `NODE_ENV !== "production"` (`db/index.ts`), and its module body
 * runs a top-level `await client.execute("PRAGMA foreign_keys = ON;")` — a real
 * connection to vitest's `file:/tmp/vitest-memocall.db`. So a non-undefined
 * `globalThis.client` after the import means the connection was opened at import
 * time, which is exactly the regression.
 *
 * Verified to discriminate: restoring the pre-Phase-6 static-import version makes
 * this fail with `expected Sqlite3Client{ closed: false } to be undefined`.
 *
 * Scope is honest and narrow: the telephony provider singleton
 * (`telephony/index.ts`) is constructed without touching any global, so its half
 * of the same problem is not observable this way and is not asserted here.
 */
describe("telephony route modules are import-clean", () => {
	test("importing them opens no libsql connection", async () => {
		const g = globalThis as { client?: unknown };
		// Baseline: nothing in this file's module graph has opened one yet.
		expect(g.client).toBeUndefined();

		await import("~/app/api/telephony/recording-status/route");
		expect(g.client).toBeUndefined();

		await import("~/app/api/telephony/voice/route");
		expect(g.client).toBeUndefined();

		// `events` STATICALLY re-exports recording-status' POST, so it inherits the
		// property rather than restating it — but only as long as the re-exported
		// module keeps its own imports lazy. Asserted here so a static import added
		// EITHER side of that re-export fails at this line.
		await import("~/app/api/telephony/events/route");
		expect(g.client).toBeUndefined();
	});
});
