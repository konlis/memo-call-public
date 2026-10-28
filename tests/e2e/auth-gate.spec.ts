import { expect, test } from "@playwright/test";

// Risk: abuse — "an anonymous request reads conversation data".
//       Cheapest layer: "integration + ONE e2e
//       anon-redirect". The integration/unit halves are already covered
//       (webhooks.test.ts 403-on-signature-mismatch; conversations.test.ts
//       UNAUTHORIZED). THIS spec covers the residual no unit test reaches: the
//       Next.js route gate (src/proxy.ts) redirecting an anonymous BROWSER
//       navigation away from the S-01 panel routes.
// Seed:  modeled on seed.spec.ts (role locators, wait-for-state, self-contained).
//
// Why this fails if the risk materializes: if the gate let an anonymous visitor
// through, the browser would stay on the panel route (no redirect to /login) and
// the conversation surface — not the sign-in form — would render. Both assertions
// below would then fail. Confirmed by a deliberate-break run (gate forced open).

test("anonymous visit to a conversation route is refused and redirected to /login", async ({
	page,
}) => {
	// A concrete S-01 conversation-detail route. The id need not exist: the gate
	// fires BEFORE the page renders, so an anonymous request never reaches the
	// data layer regardless of the id.
	const protectedPath = "/conversations/e2e-anon-probe";

	await page.goto(protectedPath);

	// The gate redirects to /login and preserves the original path as callbackUrl
	// (src/proxy.ts:43-47). Wait for that state, not a fixed delay.
	await page.waitForURL(
		`**/login?callbackUrl=${encodeURIComponent(protectedPath)}`,
	);

	// Business outcome: the visitor sees the sign-in surface, NOT conversation
	// data — the request was refused, not served.
	await expect(page.getByRole("heading", { name: "MemoCall" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
