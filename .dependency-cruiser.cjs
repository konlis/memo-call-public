/**
 * dependency-cruiser configuration — MemoCall (T3 / Next.js 16 App Router)
 *
 * Tailored, NOT the generic `depcruise --init` output. Three project-specific
 * adaptations vs. the default:
 *   1. TypeScript path-alias resolution (`~/*` → `src/*`) via tsConfig, else every
 *      `~/server/...` import resolves to "not-in-package" noise.
 *   2. Next.js entry-points (page/layout/route/proxy/instrumentation) are framework-
 *      loaded, never imported — excluded from `no-orphans` so they don't false-flag.
 *   3. A MemoCall-specific rule encoding the CLAUDE.md invariant: "no consuming code
 *      may reference provider-specific response shapes" — reaching past llm/stt
 *      index.ts straight into a vendor file (deepgram/anthropic-bedrock/...) is an error.
 */

/** Regex fragment: Next.js App Router special files + framework entry-points. */
const NEXT_ENTRY_POINTS =
	"(^src/app/.+/(page|layout|loading|error|not-found|template|default|route)\\.tsx?$)" +
	"|(^src/app/(page|layout)\\.tsx?$)" +
	"|(^src/proxy\\.ts$)" +
	"|(^src/instrumentation\\.ts$)" +
	"|(^src/env\\.js$)";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "warn",
			comment:
				"Circular dependency. In legacy-mapping terms: a cycle makes any single module in it impossible to reason about (or test) in isolation.",
			from: { pathNot: "^(node_modules)" },
			to: { circular: true },
		},
		{
			name: "no-orphans",
			severity: "warn",
			comment:
				"Module imported by nobody and importing nobody — dead code or a missed entry-point. Next.js framework files are excluded below.",
			from: {
				orphan: true,
				pathNot: [
					"\\.d\\.ts$",
					"\\.(test|spec)\\.tsx?$",
					"(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$", // dotfiles (config)
					NEXT_ENTRY_POINTS,
				],
			},
			to: {},
		},
		{
			name: "not-to-test-from-src",
			severity: "error",
			comment:
				"Production code must not import test files — leaks test-only fixtures/stubs into the shipped bundle.",
			from: { pathNot: "\\.(test|spec)\\.tsx?$" },
			to: { path: "\\.(test|spec)\\.tsx?$" },
		},
		{
			name: "no-deprecated-core",
			severity: "error",
			comment: "Don't rely on deprecated Node core modules.",
			from: {},
			to: {
				dependencyTypes: ["core"],
				path: [
					"^(v8/tools/codemap)$",
					"^(punycode|domain|constants|sys|_linklist|_stream_wrap)$",
				],
			},
		},
		{
			name: "not-to-dev-dep",
			severity: "error",
			comment:
				"Production source pulling a devDependency — it won't exist in the prod install. Tests are exempt.",
			from: { path: "^src", pathNot: "\\.(test|spec)\\.tsx?$" },
			to: {
				dependencyTypes: ["npm-dev"],
				dependencyTypesNot: ["type-only"],
				pathNot: ["node_modules/@types/"],
			},
		},

		// ---- MemoCall-specific architectural invariants (from CLAUDE.md) ----
		{
			name: "llm-provider-abstraction",
			severity: "error",
			comment:
				"PRD FR-003/FR-004: no consuming code may reference a provider-specific shape. Import the LLM through src/server/llm (index/types/service files), NEVER a vendor file directly. Only code INSIDE src/server/llm/ (the factory) may.",
			from: { pathNot: ["^src/server/llm/", "\\.(test|spec)\\.tsx?$"] },
			to: { path: "^src/server/llm/(anthropic-bedrock|mock)\\.ts$" },
		},
		{
			name: "no-worker-to-registry",
			severity: "error",
			comment:
				"Dispatch direction is one-way: registry.ts imports the workers, never the reverse. A worker importing it closes a cycle, and 'which kind runs which pipeline' stops having a single home — the exact duplication the registry replaced. A worker never needs it: each passes its own kind to claimJob, which states which kind IT handles, not which kinds exist. Kept as its OWN error rule rather than leaning on no-circular, which is severity 'warn' — and depcruise exits 0 on warnings, so a cycle would ship with every local gate green (there is no CI).",
			from: { path: "^src/server/jobs/(worker|reanalyze)\\.ts$" },
			to: { path: "^src/server/jobs/registry\\.ts$" },
		},
		{
			name: "stt-provider-abstraction",
			severity: "error",
			comment:
				"PRD FR-003/FR-004 (STT twin of the rule above): reach the STT provider through src/server/stt, never a vendor file (deepgram/google-cloud/mock) directly.",
			from: { pathNot: ["^src/server/stt/", "\\.(test|spec)\\.tsx?$"] },
			to: { path: "^src/server/stt/(deepgram|google-cloud|mock)\\.ts$" },
		},
		{
			name: "telephony-provider-abstraction",
			severity: "error",
			comment:
				"PRD FR-003/FR-004 (telephony twin of the two rules above): reach the telephony provider through src/server/telephony, never a vendor file (twilio/twilio-params/mock/zadarma/zadarma-params/zadarma-signature/zadarma-statistics) directly. This rule was MISSING while llm/stt had theirs, which is why this is the abstraction that leaked. SCOPE, so a green run is not over-read: it sees IMPORTS only. The vendor-shaped string literals that used to sit outside this directory (the signature header in webhooks.ts, the recording MIME type in jobs/worker.ts) are now provider properties, but an import rule still cannot see a literal — what pins those is the Pick<> on each consumer's deps. Like every rule here it runs locally only; no workflow executes depcruise.",
			from: { pathNot: ["^src/server/telephony/", "\\.(test|spec)\\.tsx?$"] },
			to: {
				// DENY-BY-DEFAULT, not a list of vendors (full-review F10c). This used
				// to enumerate the vendor filenames, while its sibling
				// `telephony-params-are-pure` matched by PATTERN — so adding
				// `zadarma-statistics.ts` had to be remembered HERE by hand (it nearly
				// was not), and the next vendor file with an unforeseen suffix would
				// have been caught by the purity rule and escaped this one silently.
				// Now everything in the directory is off-limits except the four
				// modules that ARE the public surface, so a new file is protected the
				// moment it lands and the failure mode of forgetting is a build error
				// rather than a hole.
				path: "^src/server/telephony/.+\\.ts$",
				pathNot: [
					"^src/server/telephony/index\\.ts$",
					"^src/server/telephony/types\\.ts$",
					"^src/server/telephony/webhooks\\.ts$",
					"^src/server/telephony/ingress-log\\.ts$",
					"^src/server/telephony/phone\\.ts$",
				],
			},
		},
		{
			name: "telephony-params-are-pure",
			severity: "error",
			comment:
				"The `*-params.ts` field mappers and the `*-statistics.ts` / `*-counterparty.ts` response mappers must import NOTHING but the vendor-neutral contract in types.ts and each other. TWO separate security properties rest on this, not tidiness. (1) SIDE-EFFECT FREEDOM, for the `*-params.ts` half: `handleRecordingStatus` deliberately calls `parseRecordingEvent` BEFORE it verifies the webhook signature, so that a provider posting many event types to one account-level URL does not get a 403 on every ordinary lifecycle event (FU-3). That ordering is only safe while the mappers have no side effect: one console.error added to a mapper hands an unauthenticated caller a write primitive against Fly's ~7-day log window, which is the same evidence-eviction attack the phase-2 review removed from zadarma.ts (F3). (2) NO EGRESS FOR PHONE NUMBERS, for the `*-statistics.ts` and `*-counterparty.ts` half: those rows carry the other party's number. Since FR-025 (caller-identity-in-archive, 2026-10-19) that number MAY be persisted \u2014 on `conversations`, by ONE path, `jobs/counterparty.ts`, via an UPDATE of a `pending` row \u2014 but the mappers are still not that path: `*-statistics.ts` is forbidden by its own source test to even name `clid`/`destination`, and `*-counterparty.ts` may read them only to RETURN a `CounterpartyResolution`. Cutting both off from ~/env, the database and the logger means neither has anywhere to carry a number EXCEPT its return value \u2014 structural, not a promise \u2014 and the source tests (`no console/process/fetch`) close the globals an import rule cannot see. Note the `to` allowance for `*-params.ts`: it is what lets both mappers share the single PBX_CALL_ID_SHAPE rather than keep copies of a security-relevant regex. Until this rule existed the property rested on a comment. Local gate only \u2014 no workflow runs depcruise.",
			from: {
				path: [
					"^src/server/telephony/[a-z-]+-params\\.ts$",
					"^src/server/telephony/[a-z-]+-statistics\\.ts$",
					"^src/server/telephony/[a-z-]+-counterparty\\.ts$",
				],
			},
			to: {
				pathNot: [
					"^src/server/telephony/types\\.ts$",
					"^src/server/telephony/[a-z-]+-params\\.ts$",
				],
			},
		},
		{
			name: "telephony-mock-no-vendor-sdk",
			severity: "error",
			comment:
				"The mock exists so CI and dev run the whole pipeline WITHOUT the vendor SDK. Any import path from mock.ts that reaches the `twilio` package — directly, or transitively via twilio.ts — destroys that property, and the failure would surface as an unrelated install/runtime puzzle rather than as this boundary. That is why the shared field mapping lives in its own dependency-free twilio-params.ts instead of inside twilio.ts (same split as auth/password-rules.ts out of auth/password.ts). `reachable: true` (the only such rule in this file) is what catches the transitive case; a plain path match would see the direct import and miss mock.ts → twilio.ts → twilio. Local gate only — no workflow runs depcruise, so this fails at a developer's terminal, not in CI.",
			from: { path: "^src/server/telephony/mock\\.ts$" },
			to: { path: "^node_modules/twilio(/|$)", reachable: true },
		},
	],

	options: {
		doNotFollow: { path: "node_modules" },

		// Resolve the `~/*` → `src/*` alias and type-only imports.
		tsConfig: { fileName: "tsconfig.json" },
		tsPreCompilationDeps: true,

		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default", "types"],
			extensions: [".js", ".jsx", ".ts", ".tsx", ".d.ts"],
		},

		reporterOptions: {
			dot: {
				// Collapse node_modules noise; keep our real subsystems legible when we render (later).
				collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)",
			},
			archi: {
				collapsePattern: "^(src/server/[^/]+|src/app/[^/]+|src/trpc)",
			},
		},
	},
};
