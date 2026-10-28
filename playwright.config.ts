import { defineConfig, devices } from "@playwright/test";

// Playwright config for MemoCall's E2E layer (see tests/e2e/E2E_RULES.md).
//
// The webServer below is HERMETIC and self-seeding: it migrates a throwaway
// test DB, seeds the single-user password (so the F-03 route gate redirects an
// anonymous request to /login rather than /setup — see src/proxy.ts), then
// boots the app with the DEFAULT mock providers (LLM/STT/TELEPHONY all default
// to "mock" in src/env.js, so no AWS/Deepgram/Twilio secrets are needed).
//
// A dedicated port (3100) avoids colliding with a `npm run dev` server on 3000.
// We use a PRODUCTION build + `next start` (NOT `next dev`): Next.js 16 refuses a
// second `next dev` for the same project dir, so a parallel dev server would
// collide with an active `npm run dev` session. `next start` has no such guard
// and is closer to prod (Fly serves the standalone build, not dev).
// reuseExistingServer is false so every run gets a freshly-migrated+seeded DB —
// determinism over speed for a small risk-tied suite.
const E2E_PORT = 3100;
const E2E_DATABASE_URL = "file:./e2e-test.db";
// Test-only secret (≥32 chars per env.js). NOT a real credential.
const E2E_AUTH_SECRET =
	"e2e000000000000000000000000000000000000000000000000000000000e2e0";
// Any non-empty password works — the anon-redirect test never logs in; it only
// needs password_hash to be NON-NULL so the gate targets /login.
const E2E_SEED_PASSWORD = "e2e-test-password";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: "list",
	use: {
		baseURL: `http://localhost:${E2E_PORT}`,
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// Migrate → seed password → build → start, all sharing the env block below.
		command: `node scripts/migrate.mjs && npx tsx scripts/dev-seed-auth.mjs && npm run build && npm run start -- --port ${E2E_PORT}`,
		url: `http://localhost:${E2E_PORT}`,
		reuseExistingServer: false,
		timeout: 300_000,
		env: {
			DATABASE_URL: E2E_DATABASE_URL,
			AUTH_SECRET: E2E_AUTH_SECRET,
			PASSWORD: E2E_SEED_PASSWORD,
		},
	},
});
