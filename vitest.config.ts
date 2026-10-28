import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// tests/e2e/* are Playwright specs (`@playwright/test`), not Vitest ones.
		// Vitest's default include globs `**/*.spec.ts`, so without this exclude it
		// collects them and every file fails at import ("test.describe() is called
		// in a wrong context"). The two runners share a naming convention, not a
		// runtime — `npm run test` is Vitest, `npx playwright test` is E2E.
		//
		// packages/** are standalone tools with their OWN package.json, lockfile and
		// dependency graph (see packages/code-reviewer/README.md) — NOT workspaces of
		// this app. The default include glob `**/*.test.ts` would otherwise collect
		// them and run them against the app's graph (root zod 3 alongside the
		// package's zod 4), silently undoing that isolation and making a package
		// failure fail the app's suite. Each package runs its own `npm test`.
		//
		// .next/** is BUILD OUTPUT, and it contains test files: next.config.js's
		// `outputFileTracingIncludes` copies `scripts/**` verbatim into the
		// standalone bundle, `scripts/onboard/lib.test.ts` included. Vitest's
		// default excludes cover node_modules and dist but NOT .next, so after any
		// `npm run build` the suite silently collected a SECOND, FROZEN copy of
		// that file and ran it as if it were source. Two bad consequences, both
		// observed 2026-09-08: the test count moved depending on whether a build
		// had happened (643 → 721 with no test added), and the stale copy kept
		// passing against code that had since changed — a green run asserting
		// something the repo no longer says. Editing the real file does not fix
		// the copy; only a rebuild or an `rm -rf .next` does.
		exclude: [
			...configDefaults.exclude,
			"tests/e2e/**",
			"packages/**",
			".next/**",
		],
		env: {
			// env.js requires DATABASE_URL; tests inject stub providers and never
			// open this file, so a non-existent path keeps Zod validation happy.
			DATABASE_URL: "file:/tmp/vitest-memocall.db",
			// AUTH_SECRET: F-03. Tests stub authorize() inputs and never invoke
			// real JWT crypto; this satisfies Zod's min-length without configuring
			// real JWT behavior. 38 chars, comfortably above the 32-char floor.
			AUTH_SECRET: "test-secret-min-32-chars-aaaaaaaaaa",
			// PUBLIC_BASE_URL: calls.placeOutbound derives the absolute recording
			// callback URL from it; `~/env` parses once at import, so it must be set
			// here (not per-test) for the outbound router test to reach placeCall.
			PUBLIC_BASE_URL: "https://test.memo-call.example",
		},
	},
	resolve: {
		alias: {
			"~": path.resolve(import.meta.dirname, "./src"),
		},
	},
});
