# E2E Testing Rules (MemoCall)

These rules govern every Playwright test in `tests/e2e/`. They keep generated
tests stable by default. Source: `.claude/skills/10x-e2e/references/e2e-quality-rules.md`
+ Playwright official Best Practices. The exemplar is `seed.spec.ts` — model new
tests on it.

- Use `getByRole`, `getByLabel`, `getByText` as primary locators.
  Fall back to `getByTestId` only when accessibility attributes are ambiguous.
- Never use CSS selectors, XPath, or DOM structure for locating elements.
- Each test must be independently runnable — no shared state between tests.
- Never use `page.waitForTimeout()`. Wait for specific conditions:
  `toBeVisible()`, `waitForURL()`, `waitForResponse()`.
- Assert the business outcome, not implementation details.
- Use unique identifiers (e.g. timestamp suffix) for any test data you create,
  and clean up in `afterEach` (teardown-before-setup also works).
- Use `storageState` for authentication — never log in through the UI inside an
  individual test. (The current suite's only risk is the *anonymous* path, which
  needs no auth.)

## Real vs mocked (this project)

- **Real, never mocked:** the auth gate (`src/proxy.ts`), routing, and the libsql
  DB — that's where the integration risk this suite protects actually lives.
- **Mocked by default at boot:** STT / LLM / telephony providers (`src/env.js`
  defaults every `*_PROVIDER` to `mock`), so no external vendor is called.

## The control question (every assertion must pass it)

> Would this assertion FAIL if the risk it guards (named in the spec's
> header comment) materialized?

If not, the assertion is decorative — fix it. Confirm with a deliberate break:
weaken the production behavior the risk targets and watch the test go red.
