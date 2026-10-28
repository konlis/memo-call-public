/**
 * Source guard (FR-025, guard #5 of `caller-identity-in-archive` plan
 * §Strażnicy per sztuka): the counterparty's number may be BOUND to a
 * statement in exactly one place.
 *
 * The property the schema comment states — "one write path" — cannot be
 * expressed in the type system (any module importing `conversations` can
 * `.set({ counterpartyE164 })`) and its violation is invisible at runtime (a
 * second writer produces correct-looking rows). So, as with
 * `redact-sinks.test.ts` and `integration-db-paths.test.ts`, it is asserted
 * over the source text: the four spellings of the two number-bearing columns
 * may appear, outside comments, only in (paths under `src/`; the scan covers
 * ALL of `src`, `.ts` and `.tsx`, like `redact-sinks.test.ts` since its F3 —
 * a Route Handler under `src/app/api/*` is a server module too; full-plan
 * impl-review F9)
 *
 *   - `server/db/schema.ts`                — the definition;
 *   - `server/jobs/counterparty.ts`        — the resolver, the ONE writer;
 *   - `server/api/routers/conversations.ts`— the reader (`list` / `getById`
 *                                             and the label mutation, phase 4),
 *                                             which selects and joins on it but
 *                                             never writes it.
 *
 * `counterparty_state` / `counterpartyState` are deliberately NOT guarded:
 * the INSERT path (`backfill.ts`) sets the constant `'pending'`, and a state
 * carries no number. What this guard protects is the number and the name.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");

const ALLOWED = new Set([
	path.join("server", "db", "schema.ts"),
	path.join("server", "jobs", "counterparty.ts"),
	path.join("server", "api", "routers", "conversations.ts"),
]);

const NUMBER_COLUMNS =
	/\b(?:counterpartyE164|counterpartyNameHint|counterparty_e164|counterparty_name_hint)\b/;

function sourceFiles(): string[] {
	return readdirSync(SRC, { recursive: true, encoding: "utf8" })
		.filter(
			(f) =>
				(f.endsWith(".ts") || f.endsWith(".tsx")) &&
				!f.endsWith(".test.ts") &&
				!f.endsWith(".test.tsx"),
		)
		.map((f) => path.join(SRC, f));
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("the counterparty number has ONE write path (FR-025)", () => {
	it("finds the modules it is supposed to be guarding", () => {
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(30);
		const naming = files.filter((f) =>
			NUMBER_COLUMNS.test(stripComments(readFileSync(f, "utf8"))),
		);
		// The schema and the resolver MUST name the columns — a walker that found
		// neither would make the assertion below vacuous.
		const rel = naming.map((f) => path.relative(SRC, f));
		expect(rel).toContain(path.join("server", "db", "schema.ts"));
		expect(rel).toContain(path.join("server", "jobs", "counterparty.ts"));
	});

	it("names the number columns in no module outside the allow-list", () => {
		const offenders = sourceFiles()
			.filter((f) =>
				NUMBER_COLUMNS.test(stripComments(readFileSync(f, "utf8"))),
			)
			.map((f) => path.relative(SRC, f))
			.filter((f) => !ALLOWED.has(f));
		expect(
			offenders,
			"the counterparty number is written by jobs/counterparty.ts and read by api/routers/conversations.ts — nothing else may bind it (schema.ts, `conversations` comment)",
		).toEqual([]);
	});

	it("the predicate detects each spelling it claims to", () => {
		for (const spelling of [
			"set({ counterpartyE164: x })",
			"counterpartyNameHint: null",
			"sql`counterparty_e164 = ?`",
			"UPDATE t SET counterparty_name_hint = NULL",
		]) {
			expect(NUMBER_COLUMNS.test(spelling), spelling).toBe(true);
		}
		expect(NUMBER_COLUMNS.test("counterpartyState: 'pending'")).toBe(false);
		expect(NUMBER_COLUMNS.test("counterparty_state = 'pending'")).toBe(false);
	});
});
