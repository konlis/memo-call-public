# CLAUDE.md

Guidance for Claude Code (and human contributors) working in this repository. It holds the
rules and traps that are not obvious from the code. The deploy runbook is in `README.md`; the
privacy model is in `context/domain/04-privacy-and-anonymity.md`.

## Project

**MemoCall** — privacy-conscious call-notes assistant for a single solo Polish-speaking
professional. A recorded call flows telephony (Zadarma, or Twilio as the retreat path) →
Deepgram Nova-3 (EU STT) → Claude Haiku 4.5 on Amazon Bedrock (EU LLM) → a private TLS web
panel. Runs on Fly.io (`fra`) as one always-on Machine with SQLite on a volume.

## Critical product constraints

These are not negotiable. Treat a violation as a review blocker.

- **EU data residency end-to-end.** STT and LLM are pinned in code (`api.eu.deepgram.com`,
  `AWS_REGION=eu-central-1`, the `eu.` Bedrock inference profile) and a wrong-region key fails
  loud. Telephony is pinned by contract only: Zadarma has no regional endpoint, so the guarantee
  is its EU jurisdiction plus the DPA. Any telephony vendor change is a residency decision, not
  a config diff.
- **Vendor-contract-bound privacy.** STT and LLM run under no-training terms. Telephony is
  **transit-only**: a recording is deleted at the vendor once its job succeeds, and audio never
  persists in this app or its working directory.
- **TLS-only.** The panel answers HTTPS only; no HTTP fallback.
- **Strict single-user.** One installation = one user. `ctx.userId` is the constant `'me'`.
- **BUT: schema is multi-user-ready.** Every user-owned table has a `user_id` text FK, indexed
  `user_id`-first, and every query and INSERT names it explicitly — even though the value is
  always `'me'`. Never drop it "because we're single-user anyway"; that turns a day-1 cost into
  a multi-week retrofit.
- **Provider abstractions, not vendor shapes.** STT, LLM and telephony go through interfaces in
  `src/server/{stt,llm,telephony}/`. No consuming code (UI, routers, jobs) may reference a
  vendor-specific response shape. `.dependency-cruiser.cjs` enforces this.
- **No realtime.** Transcription is strictly post-call; no WebSocket/SSE in the main flow.
- **Constrained classification.** Category is binary (`praca` / `prywatne`); a project belongs
  to a category. LLM output is Zod-validated with up to 3 retry-with-feedback attempts, then
  the conversation is marked "no auto-assignment" — never silently unassigned.

## Commands

```bash
npm run dev            # Next.js dev (Turbo), port 3000
npm run build          # production build (output: standalone)
npm run typecheck      # tsc --noEmit
npm run check          # Biome lint + format (check:write to fix)
npm run test           # Vitest single run
npm run depcruise      # architectural rules

DATABASE_URL="file:./db.sqlite" node scripts/migrate.mjs   # create/upgrade a dev DB
npm run db:generate    # emit a migration into drizzle/
```

⚠️ Do not build a dev DB with `npm run db:push`: drizzle-kit cannot model the hand-written FTS5
index (`drizzle/0005`), and the first search fails with `no such table`.

## Production (Fly.io)

Volume `/data` (3 GB, encrypted at rest, 5 automatic snapshots retained). SQLite at
`/data/db.sqlite`. Migrations run on Machine boot from `docker-entrypoint.sh`, not from a
`release_command` (that ephemeral Machine cannot attach the single-attach volume).

### Required secrets

Set with `fly secrets set`, never committed. `node scripts/onboard.mjs` validates them and
prints the commands in the right order.

- `DATABASE_URL`, `AUTH_SECRET` (≥32 chars — generate into a variable and check the length
  first: `fly secrets set X="$(cmd)"` silently sets an empty value when `cmd` fails),
  `AUTH_URL` (public origin, no trailing slash — otherwise sign-out redirects to `0.0.0.0`).
- `TELEPHONY_PROVIDER` is **boot-gating**: `mock` is refused in production, because the mock
  accepts every webhook signature and webhooks bypass the session gate.
- Provider credentials (`DEEPGRAM_API_KEY`, the four AWS vars, `ZADARMA_*` / `TWILIO_*`,
  `USER_FORWARD_NUMBER`, `PUBLIC_BASE_URL`) are validated at provider construction and fail
  loud at boot.

**Enum-before-secret rule.** When code adds a new value to a `*_PROVIDER` enum in `src/env.js`,
`fly deploy` the image carrying it **before** setting the secret. Setting it first restarts the
old image, which dies on env validation and crash-loops.

### Docker build pattern

Do not run `fly launch` again; it regenerates `Dockerfile` and `fly.toml` and drops the fixes
documented inline. The builder pins npm 11 to match the lockfile's generator (npm 10 rejects it
in `npm ci`). The final stage copies the full `node_modules`, so **anything in the root
`package.json` ships to the production image** — keep dev tooling out of it.

### Emergency / one-off fallbacks

`fly ssh console --machine <id>` gives full read/write access to `/data/db.sqlite` through the
bundled `@libsql/client` (there is no `sqlite3` CLI). Always pass `--machine`: a bare session
can land on an ephemeral machine without the volume, where writes appear to succeed and are
discarded. Prefer a forward migration over ad-hoc writes.

## Architecture

**Path alias:** `~/` → `src/`. Use it instead of relative paths.

**tRPC:** `createTRPCContext` (`src/server/api/trpc.ts`) injects `db`, the session and
`userId: 'me'`. Every procedure that touches user data is a `protectedProcedure`. In dev,
`timingMiddleware` adds a **random 100–500 ms delay** on purpose, to surface waterfalls.

### Database schema (multi-user-ready)

- Tables are prefixed `memo-call_`. Every non-`users` table carries
  `user_id … references(users.id, { onDelete: "cascade" })` and a `user_id`-first index.
- **`PRAGMA foreign_keys = ON;` on every new libsql connection** — the client defaults it OFF,
  which silently disables every `ON DELETE CASCADE`. See `src/server/db/index.ts`.
- The seed row `'me'` is a hand edit at the tail of `drizzle/0000_*.sql`; re-apply it if you
  ever regenerate that file.
- A migration that makes drizzle-kit **recreate** `conversations` drops the three FTS5 sync
  triggers. Append them again (copied from `0005`); `fts-migration.test.ts` catches a miss.
- **Phone numbers (§A-1 of the privacy doc).** The counterparty number on `conversations` is
  written by one path only, `runCounterpartySweep` (`src/server/jobs/counterparty.ts`);
  `counterparty-write-path.test.ts` enforces it. A number must never reach an LLM prompt, a log
  line, `last_error` or the FTS index — every log sink goes through `safeErrorMessage`
  (`src/server/_lib/redact.ts`), enforced by `redact-sinks.test.ts`.

### Provider abstractions (LLM + STT)

- One generic primitive per provider: `LlmProvider.generateStructured({ prompt, schema })` and
  `SttProvider.transcribe({ audio })`. Business functions (`analyze`, `classify`) live above
  the provider, not on the interface.
- Transport retries live in the provider; constraint retries (3 attempts with feedback) live in
  `src/server/llm/classify.ts`.
- One error type: `ProviderError` with `code ∈ transport | rate_limited | auth |
  invalid_response | refusal | unknown`. Assert on `name` + `code`, not `instanceof`:
  `vi.resetModules()` creates a second class identity. The LLM mock picks its canned value by
  `schema.safeParse` for the same reason (HMR re-creates schema objects).
- **Adding a vendor changes exactly three places:** a new file in the provider directory, a new
  enum value in `src/env.js` (schema **and** `runtimeEnv`), and a branch in that directory's
  `index.ts`. A change anywhere else means the provider is leaking its shape.

### Tag vocabulary in the analyze() prompt

`analyze()` receives existing tag names (`loadPromptVocabulary`, `src/server/jobs/vocabulary.ts`)
so the model reuses them. The list **constrains the output space**; it is not few-shot
training data and must not grow into a learning loop over the user's past answers.
`AnalyzeInput.vocabulary` is required (empty allowed) so no call site can forget it.

Both job workers write tags through the single reconciler `src/server/tags/reconcile.ts`, with a
policy argument (`replace-all` for first runs and replays, `merge` for re-analysis, which keeps
user-edited tags). Never re-implement a policy at a call site.

### Telephony

- Webhooks are Route Handlers under `src/app/api/telephony/`, not tRPC (form-encoded bodies, raw
  body needed for the signature). The signature is the only auth; `proxy.ts` excludes
  `/api/telephony/*` from the session gate.
- `*-params.ts` mappers must stay pure (dependency-cruiser rule): they run before the signature
  check, so a side effect there is an unauthenticated write primitive into the logs.
- Zadarma: no vendor SDK (it has a fail-open verifier and would ship in the root
  `package.json`). One HMAC encoding, `base64(hex digest)`, for both directions. The signature
  covers no URL or nonce, so replays are defused by the `conv_user_callsid_uq` index plus
  `onConflictDoNothing` — that index is a security control.
- Zadarma statistics: one `pbx_call_id` has several rows — a trunk leg (`sip: "0"`) and an
  extension leg (e.g. `sip: "100"`). Filter `is_recorded` first, then take the longest
  `seconds`; never select on `sip`, which is per-PBX configuration.
- `ZADARMA_SIP_EXTENSION` is the bare extension (`100`), not the SIP login (`123456-100`).
  `speech_recognition = off` on the extension yields mono audio and silently breaks the speaker
  split — keep it `optional`.

### Authentication (F-03)

- Auth.js v5, credentials provider, JWT sessions (30 days). Password: bcrypt cost 12, rule
  "≥12 chars OR ≥4 words" (`password-rules.ts`). Per-IP throttle (`throttle.ts`) plus account
  lockout after 50 failures for 30 minutes (`lockout.ts`); every outcome goes to the auth audit
  log (`audit.ts`).
- The route gate is `src/proxy.ts` (Next.js 16 name for middleware). It **must** live in `src/`;
  a repo-root `proxy.ts` is silently ignored. Unauthenticated visitors go to `/setup` until a
  password exists, then to `/login`.
- `/setup` is one-shot: the mutation writes only where `password_hash IS NULL`. Until it is
  completed on a fresh deploy, the first visitor can claim the instance.

## Testing

- Vitest, `environment: 'node'`, alias `~` → `src/`. `happy-dom` is not installed — there are no
  DOM component tests yet; add it with the first one.
- Anything that is SQL is tested against **real libsql** with real migrations via the helper in
  `src/server/db/integration-test-db.ts`; `integration-db-paths.test.ts` fails a suite that
  opens a client by hand.
- Telephony route tests assert wiring only and rely on `await import()` inside the handlers;
  a static import of `~/server/db` makes the route un-importable in a test.
- E2E: Playwright in `tests/e2e/` (see `E2E_RULES.md`).
- `npm audit fix` is fine; **`npm audit fix --force` is banned** — it oscillates drizzle-kit
  down to 0.18.1, which removes every `db:*` command.

## Lessons

Rules distilled from real failures in this codebase. Code comments cite them as
`CLAUDE.md "Lessons"`.

- **A stub db lies about SQL.** A unit test against a stubbed db cannot catch malformed SQL,
  `ON CONFLICT` emission or `BEGIN…ROLLBACK` behaviour. Anything that is SQL gets a real-libsql
  integration test with the real migrations applied.
- **`onConflictDoNothing({ target, where })` mis-positions a partial-index predicate.** Use
  target-less `.onConflictDoNothing()` when the intended conflict is the only realistic one, or
  raw `sql` for the clause, and cover every `ON CONFLICT` path with an integration test.
- **drizzle-kit emits the `memo-call_` prefix unquoted in `ALTER … ADD … REFERENCES`.** Apply
  every migration that adds an FK to an existing table against a throwaway DB before commit;
  hand-edit it with a `HAND-EDIT` guard comment if it breaks.
- **Mixed column case is the convention.** Business columns get an explicit snake_case name;
  timestamps without one land as camelCase, so hand-written SQL must quote `createdAt`.
- **A green local build does not prove a deploy.** Keep `proxy.ts` in `src/`, align the
  builder's npm with the lockfile, and mark DB-reading server components
  `export const dynamic = "force-dynamic"` — sanity-build against an empty placeholder DB.
- **`outputFileTracingIncludes` copies files but does not trace their imports.** Scripts run
  outside the routing graph (the migrator) need `node_modules` copied into the image.
- **Region-scoped keys and enum-before-secret.** An EU endpoint needs a key from an EU project
  (a wrong-region key is a plain 401). Deploy the enum value before flipping its secret.
- **Probe what the provider actually calls.** A pre-flight must hit the same host and path the
  real provider authenticates against; management routes may not exist on an inference host.
- **Generate secrets into a variable and check the length** before `fly secrets set`.
- **`Content-Length` is not a body-size limit.** Use it only as a fast 413 path; enforce the cap
  with a running byte total over the stream.
- **A fixed DB path in an integration suite is a race that looks like a flake.** Every suite
  gets its path from the shared helper; `integration-db-paths.test.ts` enforces it.
- **A frozen test vector needs independent provenance.** Write next to each fixture where it
  came from (vendor SDK, spec, live capture). A vector produced by the code under test is a
  change detector, not a correctness test.
- **Source-scanning guards strip comments first.** Prose that merely mentions a path or field
  must not trip the guard, or the guard pushes people to delete the warning.
- **Assert a log line by its emitted shape**, after any mapper, and prefer "line present with
  value X" over "string absent".
- **A documented row-level invariant needs an index.** Either a unique index enforces "one row
  per X", or the comment says it is unenforced and what breaks.
