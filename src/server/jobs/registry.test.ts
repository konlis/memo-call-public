import { describe, expect, test } from "vitest";
import { reanalyzeJob, reanalyzeKickoff } from "~/server/jobs/reanalyze";
import {
	DEFAULT_JOB_KIND,
	isJobKind,
	JOB_HANDLERS,
	JOB_KINDS,
	resolveJobHandler,
} from "~/server/jobs/registry";
import { kickoff, processJob } from "~/server/jobs/worker";

// Pure mapping table — no DB. Identity assertions are the right tool here
// precisely because the module under test IS a lookup: its whole job is "this
// kind → that pair of functions", so comparing against the imported functions
// tests the contract rather than an implementation detail.
//
// This suite also closes the coverage gap recorded as FU-2 (Phase 1 impl-review):
// before the registry, the production `kind → worker` branch lived inline in
// `jobs.ts` `DEFAULT_DEPS` and was executed by no test, because every router test
// injects a spy in its place.

describe("JOB_HANDLERS — the dispatch table", () => {
	test("analyze maps to the audio-first pipeline", () => {
		expect(JOB_HANDLERS.analyze.run).toBe(processJob);
		expect(JOB_HANDLERS.analyze.kickoff).toBe(kickoff);
	});

	test("reanalyze maps to the transcript-sourced pipeline", () => {
		expect(JOB_HANDLERS.reanalyze.run).toBe(reanalyzeJob);
		expect(JOB_HANDLERS.reanalyze.kickoff).toBe(reanalyzeKickoff);
	});

	test("every kind gets a DISTINCT handler pair (no half-registered kind aliases another)", () => {
		// The failure this guards: someone adds a third kind, copies an existing
		// entry as a starting point, and forgets to swap in the new worker. The
		// registry would look complete while silently routing two kinds to one
		// pipeline — the same class of defect Phase 1 fixed, one layer up.
		const runs = JOB_KINDS.map((k) => JOB_HANDLERS[k].run);
		const kickoffs = JOB_KINDS.map((k) => JOB_HANDLERS[k].kickoff);
		expect(new Set(runs).size).toBe(JOB_KINDS.length);
		expect(new Set(kickoffs).size).toBe(JOB_KINDS.length);
	});

	test("JOB_KINDS lists exactly the registered kinds", () => {
		// JOB_KINDS is the poller's queue predicate, so a kind missing from it would
		// be silently un-drainable even though it has a handler.
		expect([...JOB_KINDS].sort()).toEqual(Object.keys(JOB_HANDLERS).sort());
	});
});

describe("resolveJobHandler — raw column value → handler", () => {
	test("resolves each known kind to its own handler", () => {
		expect(resolveJobHandler("analyze")).toBe(JOB_HANDLERS.analyze);
		expect(resolveJobHandler("reanalyze")).toBe(JOB_HANDLERS.reanalyze);
	});

	test("an unrecognized kind falls back to the default kind instead of throwing", () => {
		// `kind` is plain text with no CHECK constraint, so a hand-edited migration
		// or the documented emergency SSH INSERT can produce anything. Resolving off
		// the request path must never throw — the fallback handler's claim is itself
		// kind-scoped, so the outcome is a no-op, not a wrong-pipeline run.
		expect(resolveJobHandler("summarize")).toBe(JOB_HANDLERS[DEFAULT_JOB_KIND]);
		expect(resolveJobHandler("")).toBe(JOB_HANDLERS[DEFAULT_JOB_KIND]);
	});

	test("the documented fallback is the audio-first kind (mirrors the column default)", () => {
		// `drizzle/0002` shipped `kind text DEFAULT 'analyze' NOT NULL`; the fallback
		// must agree with the DB default or the two would disagree about what an
		// unspecified kind means.
		expect(DEFAULT_JOB_KIND).toBe("analyze");
	});
});

describe("isJobKind", () => {
	test("accepts registered kinds and rejects everything else", () => {
		expect(isJobKind("analyze")).toBe(true);
		expect(isJobKind("reanalyze")).toBe(true);
		expect(isJobKind("analyse")).toBe(false); // the typo a bare string would hide
		expect(isJobKind("toString")).toBe(false); // not fooled by Object.prototype keys
	});
});
