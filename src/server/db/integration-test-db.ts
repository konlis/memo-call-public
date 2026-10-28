/**
 * Shared path/cleanup helper for the real-libsql integration suites (FU-2).
 *
 * NOT production code — nothing in the app graph imports it. It does not live in
 * a `*.test.ts` file because the `not-to-test-from-src` depcruise rule (severity
 * `error`) forbids non-test modules from importing test files, and this is a
 * module several test files import.
 *
 * WHY IT EXISTS. Every integration suite used a FIXED path
 * (`/tmp/memocall-<name>-itest.db`) plus an `rmSync` in `beforeAll`. Two
 * concurrent `npm test` runs — two terminals, or a CI matrix with two jobs on
 * one runner — therefore delete each other's databases mid-run, and the suite
 * that loses the race dies with
 * `LibsqlError: SQLITE_READONLY_DBMOVED: attempt to write a readonly database`.
 * This was not theoretical: it happened live during the phase-2 review of
 * `telephony-provider-zadarma` (F6).
 *
 * The symptom is the expensive part. In isolation every suite is green, so the
 * failure looks like a random flake and gets attributed to whatever change
 * happens to be under review — a debugging tax paid by whoever is unlucky, not
 * by whoever wrote the shared path.
 *
 * WHY A HELPER RATHER THAN TEN SUFFIXES. Suffixing each path in place fixes
 * today's ten files and does nothing about the eleventh, which will be written
 * by copying one of them. `integration-db-paths.test.ts` scans for the fixed-path
 * shape and fails, so the invariant is enforced rather than remembered.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A DB path unique to this process AND this call.
 *
 * `process.pid` alone satisfies the concurrent-runs case and keeps the filename
 * greppable back to a run; the random suffix additionally covers same-pid
 * collisions, which Vitest's `threads` pool would make possible (the default
 * pool is `forks`, but the config does not pin one, so the guarantee should not
 * depend on that default).
 *
 * @param name short suite identifier, e.g. `"tags-router"`
 */
export function makeIntegrationDbPath(name: string): string {
	// `tmpdir()` rather than a hardcoded `/tmp` — it honours TMPDIR and is the
	// portable spelling; no suite should care where the file lands.
	return path.join(
		tmpdir(),
		`memocall-${name}-itest-${process.pid}-${randomUUID().slice(0, 8)}.db`,
	);
}

/**
 * Remove a libsql database and its sidecars. SQLite in WAL mode keeps `-wal`
 * and `-shm` next to the file; leaving them behind lets a stale write-ahead log
 * resurrect rows in a suite that expects an empty schema.
 */
export function cleanupIntegrationDb(dbPath: string): void {
	// `-journal` covers rollback-journal mode too: `calls.test.ts` already listed
	// it while the other nine did not, and one shared list ends that divergence.
	for (const suffix of ["", "-journal", "-wal", "-shm"]) {
		rmSync(`${dbPath}${suffix}`, { force: true });
	}
}

/**
 * Wrap a drizzle handle so that `select(...).from(<table>)` THROWS, while every
 * other query on the same handle keeps working.
 *
 * Exists for one criterion (`tag-vocabulary-control` 5.7): both job workers must
 * survive a failed tag-vocabulary read and finish the job with an empty
 * vocabulary. Proving that needs a database where exactly ONE read fails —
 * closing the client or pointing at a missing file breaks every query instead,
 * which would prove nothing about the degradation path.
 *
 * Two details keep the wrapper honest rather than merely convenient:
 *
 *  - The interception is on the TABLE OBJECT (`source === table`), not on SQL
 *    text or call order. A worker that stops reading `tags` — or starts reading
 *    it somewhere else — changes what this helper does, which is the intent.
 *  - Only the outer handle is wrapped. The transaction handle drizzle hands the
 *    callback is the real one, so the done-txn's tag writes still run. That is
 *    the situation under test: the READ failed, the job must still land.
 *
 * Every property is bound to the real handle (never to the proxy), so drizzle's
 * internals never see the proxy as `this`.
 */
export function withFailingSelectFrom<TDb extends object>(
	db: TDb,
	table: unknown,
	message: string,
): TDb {
	const bindToTarget = (target: object, prop: string | symbol): unknown => {
		const value = Reflect.get(target, prop);
		return typeof value === "function" ? value.bind(target) : value;
	};

	return new Proxy(db, {
		get(target, prop) {
			if (prop !== "select") return bindToTarget(target, prop);
			const select = Reflect.get(target, prop) as (
				...args: unknown[]
			) => object;
			return (...args: unknown[]) => {
				const builder = select.apply(target, args);
				return new Proxy(builder, {
					get(builderTarget, builderProp) {
						if (builderProp !== "from")
							return bindToTarget(builderTarget, builderProp);
						const from = Reflect.get(builderTarget, builderProp) as (
							source: unknown,
						) => unknown;
						return (source: unknown) => {
							if (source === table) throw new Error(message);
							return from.call(builderTarget, source);
						};
					},
				});
			};
		},
	}) as TDb;
}
