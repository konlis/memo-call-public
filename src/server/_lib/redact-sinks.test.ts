/**
 * Source guard (`caller-identity-in-archive` phase 2, FR-025): no error sink
 * under `src` may read an error's raw text.
 *
 * A sink is a `console.error(...)`, `logJobEvent(...)` or `logAuthEvent(...)`
 * call, or a `lastError:` / `last_error` write. Every one of them has to go
 * through `safeErrorMessage` (or the `errorMessage` alias in `worker.ts`),
 * because a raw `DrizzleQueryError` message prints the failed statement's
 * bound values — and from phase 3 on, one of those values is the
 * counterparty's phone number. The next `console.error({ error: err.message })`
 * is exactly how that number would reach the ~7-day Fly log window, and it
 * would pass every runtime test, since no test binds a real number to a
 * failing statement in every sink.
 *
 * Banned inside a sink's argument (impl-review phase 2, F2 — each one yields
 * the raw message or more): `.message`, `.stack` (starts with the message),
 * `String(err)` / `` `${err}` `` (same), `JSON.stringify(err)` — a
 * `DrizzleQueryError` has ENUMERABLE `query`/`params`/`cause`, so this one
 * serialises the bound values verbatim. The `instanceof Error ? x.message`
 * idiom is banned anywhere in a file, not just inside a sink.
 *
 * KNOWN BLIND SPOTS, on purpose rather than by accident: a value hoisted into
 * a variable first (`const m = err.message; logJobEvent({ error: m })`), and
 * a helper in another module that returns `.message`. Both need a type-level
 * or data-flow check this text scan cannot do; the runtime defence in depth
 * in both audit loggers (`error` re-sanitized) is what covers them.
 *
 * Same technique as `integration-db-paths.test.ts`: a rule that the type
 * system cannot express and whose violation is invisible at runtime is
 * asserted over the source text, comments stripped, with a non-emptiness
 * control so the walker cannot pass vacuously.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");

/** The one module allowed to read `.message` — it IS the sanitizer. */
const SANITIZER = path.join("server", "_lib", "redact.ts");

function sourceFiles(): string[] {
	// `.ts` only: `.tsx` is client UI, which has no log sinks and whose JSX
	// would confuse the paren walker. Same root as `integration-db-paths.test.ts`
	// (all of `src`), so `src/proxy.ts` and the route handlers are inside the
	// fence too (impl-review phase 2, F3).
	return readdirSync(SRC, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.filter((f) => f !== SANITIZER)
		.map((f) => path.join(SRC, f));
}

/**
 * Strip comments. A `//` preceded by `:` is a URL inside a string literal
 * (`"https://…"`), not a comment — cutting there used to truncate the line
 * and send the paren walker below to end-of-file (F2).
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The idiom every sink used before phase 2. Banned outright: the only place it
 * may appear is inside the sanitizer.
 */
const RAW_MESSAGE_IDIOM = /instanceof\s+Error\s*\?\s*\w+\.message\b/;

/** Function calls whose argument is a log line or audit line. */
const SINK_CALLS = ["console.error(", "logJobEvent(", "logAuthEvent("];

/** Expressions that yield an error's raw text (or more) when used in a sink. */
const RAW_TEXT_SHAPES: ReadonlyArray<[string, RegExp]> = [
	[".message", /\.message\b/],
	[".stack", /\.stack\b/],
	["String(err)", /\bString\(\s*(?:err|error|e|cause|reason)\s*\)/],
	["`${err}`", /\$\{\s*(?:err|error|e|cause|reason)\s*\}/],
	["JSON.stringify(err)", /JSON\.stringify\(\s*(?:err|error|e|cause|reason)\b/],
];

/**
 * The text of each `<name>(` call: from the opening paren to its balanced
 * close. A regex cannot balance parens, so walk it.
 */
function sinkCalls(source: string): string[] {
	const calls: string[] = [];
	for (const needle of SINK_CALLS) {
		let from = 0;
		for (;;) {
			const start = source.indexOf(needle, from);
			if (start === -1) break;
			let depth = 0;
			let i = start + needle.length - 1;
			for (; i < source.length; i += 1) {
				const ch = source[i];
				if (ch === "(") depth += 1;
				else if (ch === ")") {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			calls.push(source.slice(start, i + 1));
			from = i + 1;
		}
	}
	return calls;
}

/** Which banned shapes a sink call contains. */
function rawTextShapesIn(call: string): string[] {
	return RAW_TEXT_SHAPES.filter(([, re]) => re.test(call)).map(
		([name]) => name,
	);
}

/**
 * The value expression of a `lastError:` / `last_error:` property, up to the
 * next comma or closing brace.
 */
function lastErrorValues(source: string): string[] {
	return [...source.matchAll(/\b(?:lastError|last_error)\s*:\s*([^,}]+)/g)].map(
		(m) => m[1] ?? "",
	);
}

describe("error sinks under src must go through the sanitizer (FR-025)", () => {
	it("finds the sinks it is supposed to be guarding", () => {
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(30);
		const sanitized = files.filter((f) =>
			readFileSync(f, "utf8").includes("safeErrorMessage"),
		);
		// worker, scheduler, vocabulary, calls, projects, conversations, auth,
		// both audit loggers — a walker that found none of them would make the
		// checks below vacuous.
		expect(sanitized.length).toBeGreaterThanOrEqual(6);
		const withSinks = files.filter(
			(f) => sinkCalls(stripComments(readFileSync(f, "utf8"))).length > 0,
		);
		expect(withSinks.length).toBeGreaterThanOrEqual(8);
	});

	it("no module outside the sanitizer uses the raw `instanceof Error ? x.message` idiom", () => {
		const offenders = sourceFiles().filter((f) =>
			RAW_MESSAGE_IDIOM.test(stripComments(readFileSync(f, "utf8"))),
		);
		expect(
			offenders.map((f) => path.relative(SRC, f)),
			"use safeErrorMessage(err) from ~/server/_lib/redact — a raw message can carry a DrizzleQueryError's bound values, including a phone number",
		).toEqual([]);
	});

	it("no console.error / logJobEvent / logAuthEvent call reads an error's raw text", () => {
		const offenders = sourceFiles().flatMap((f) =>
			sinkCalls(stripComments(readFileSync(f, "utf8")))
				.map((call) => rawTextShapesIn(call))
				.filter((shapes) => shapes.length > 0)
				.map((shapes) => `${path.relative(SRC, f)}: ${shapes.join(", ")}`),
		);
		expect(offenders).toEqual([]);
	});

	it("no `lastError:` / `last_error:` write reads an error's raw text", () => {
		const offenders = sourceFiles().filter((f) =>
			lastErrorValues(stripComments(readFileSync(f, "utf8"))).some(
				(value) => rawTextShapesIn(value).length > 0,
			),
		);
		expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
	});
});

/**
 * The predicates' own positive controls: each banned shape, written the way
 * a sink would write it, must be detected — otherwise the green above proves
 * only that the walker found nothing, not that it would.
 */
describe("the guard's predicates detect what they claim to", () => {
	it.each([
		["console.error(JSON.stringify({ error: err.message }))", ".message"],
		[
			"logJobEvent({ event: 'x', jobId, error: (err as Error).message })",
			".message",
		],
		[
			"logAuthEvent('login_failed_db_write_error', { ip, error: err.message })",
			".message",
		],
		["console.error(err.stack)", ".stack"],
		["console.error(String(err))", "String(err)"],
		["console.error(`tick failed: ${err}`)", "`${err}`"],
		["console.error(JSON.stringify(err))", "JSON.stringify(err)"],
	])("flags %s", (snippet, shape) => {
		const [call] = sinkCalls(snippet);
		expect(call).toBeDefined();
		expect(rawTextShapesIn(call ?? "")).toContain(shape);
	});

	it("flags a `lastError:` and a `last_error:` value, including a multi-line ternary", () => {
		const src = `
			.set({
				status: "failed",
				lastError: err instanceof Error
					? err.message
					: String(err),
			})
			await c.execute({ sql: "update x set last_error = ?", args: [] })
			const row = { last_error: String(err) }`;
		const flagged = lastErrorValues(src).filter(
			(v) => rawTextShapesIn(v).length > 0,
		);
		expect(flagged).toHaveLength(2);
	});

	it("does not flag a sanitized sink", () => {
		const [call] = sinkCalls(
			"console.error(JSON.stringify({ error: safeErrorMessage(err) }))",
		);
		expect(rawTextShapesIn(call ?? "")).toEqual([]);
	});

	it("keeps a URL literal intact when stripping comments", () => {
		const src =
			'console.error(JSON.stringify({ url: "https://x", error: err.message })) // note';
		const [call] = sinkCalls(stripComments(src));
		expect(call?.endsWith("}))")).toBe(true);
		expect(rawTextShapesIn(call ?? "")).toEqual([".message"]);
	});
});
