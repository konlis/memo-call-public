import { expect, test } from "@playwright/test";

// SEED TEST — the exemplar every generated E2E test is modeled on.
// "What you show is what you get": these four patterns propagate to every
// generated spec. See .claude/skills/10x-e2e/references/seed-test-pattern.md.
//
//   1. Role-based locators  — getByRole / getByLabel, never CSS / XPath.
//   2. Test independence    — own setup + action + assertion, no shared state.
//   3. Wait for STATE       — toBeVisible() / waitForURL(), never waitForTimeout().
//   4. Risk-tied name       — the test name binds it to a real behavior.
//
// This seed drives a read-only, unauthenticated flow (the public /login surface),
// so it needs no auth and creates no data — hence no cleanup block. Cleanup
// matters only when a test CREATES persistent data (then: unique ids + afterEach).

test("login page renders its sign-in form for an unauthenticated visitor", async ({
	page,
}) => {
	await page.goto("/login");

	// Role/label locators — exactly what the accessibility tree exposes.
	await expect(page.getByRole("heading", { name: "MemoCall" })).toBeVisible();
	await expect(page.getByLabel("Password")).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
