/**
 * Guard for FU-2: no integration suite may hardcode its database path.
 *
 * The defect this prevents is a RACE, so it cannot be caught by the suites
 * themselves — each one is green in isolation, and only two concurrent
 * `npm test` runs (two terminals, or a CI matrix with two jobs on one runner)
 * make them delete each other's files. The loser dies with
 * `SQLITE_READONLY_DBMOVED`, which reads as a random flake and gets blamed on
 * whatever change is under review. Reproduced deterministically on 2026-09-07:
 * with fixed paths, 3 of 3 paired runs failed; with unique paths, 0 of 3.
 *
 * Rewriting the ten existing suites fixed those ten. This file is what fixes
 * the ELEVENTH — the one that will be written by copying one of them, where a
 * dropped suffix would restore the race silently and nothing would fail until
 * somebody happens to run two suites at once.
 *
 * The technique: when a rule cannot be expressed in the type system and its violation is
 * invisible at runtime, assert it over the source text.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");

/** This guard itself quotes the forbidden shape in its own fixtures/prose. */
const SELF = "integration-db-paths.test.ts";

function testFiles(): string[] {
	return readdirSync(SRC, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".test.ts") && !f.endsWith(SELF))
		.map((f) => path.join(SRC, f));
}

/**
 * Strip comments before scanning. Without this the guard flags prose that
 * merely MENTIONS a path — `import-clean.test.ts` documents vitest's
 * placeholder DB in a doc comment, and a guard that fires on documentation
 * trains people to weaken it.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `const X = "…/foo.db"` — a string literal path assigned to something. */
const HARDCODED_DB_LITERAL = /=\s*(["'`])[^"'`\n]*\.db\1/;

describe("integration suites must not hardcode a database path (FU-2)", () => {
	it("finds the suites it is supposed to be guarding", () => {
		// A walker that silently matched nothing would make every assertion below
		// vacuously true — the failure mode of every source-scanning test.
		const files = testFiles();
		expect(files.length).toBeGreaterThan(20);
		expect(
			files.filter((f) => readFileSync(f, "utf8").includes("DB_PATH")).length,
		).toBeGreaterThanOrEqual(10);
	});

	it("no test file assigns a hardcoded .db path", () => {
		const offenders = testFiles().filter((file) =>
			HARDCODED_DB_LITERAL.test(stripComments(readFileSync(file, "utf8"))),
		);
		expect(
			offenders.map((f) => path.relative(SRC, f)),
			"use makeIntegrationDbPath() from ~/server/db/integration-test-db — a fixed path makes two concurrent test runs delete each other's databases",
		).toEqual([]);
	});

	it("every suite that uses DB_PATH gets it from the shared helper", () => {
		// The direct anti-copy-paste check: a new suite cloned from an existing one
		// keeps the DB_PATH shape, so requiring the import catches a hand-rolled
		// path even in a spelling `HARDCODED_DB_LITERAL` does not recognize.
		const offenders = testFiles().filter((file) => {
			const source = readFileSync(file, "utf8");
			return (
				source.includes("DB_PATH") && !source.includes("makeIntegrationDbPath")
			);
		});
		expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
	});
});
