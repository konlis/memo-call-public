# Security Policy

MemoCall processes recordings and transcripts of real phone calls, so security
reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](../../security/advisories/new)
(Security tab → *Report a vulnerability*). Include the affected file or route,
steps to reproduce, and the impact you observed. You can expect an initial
reply within a few working days.

## Scope

In scope: the code in this repository — the auth gate (`src/proxy.ts`,
`src/server/auth/`), the telephony webhook signature checks
(`src/server/telephony/webhooks.ts`), tRPC procedures, and the onboarding
scripts.

Out of scope: vulnerabilities in third-party vendors (Fly.io, Zadarma, Twilio,
Deepgram, AWS Bedrock) and in deployments that changed the security defaults
documented in the README.

## Deployment notes for operators

- Every instance is single-user. Set the panel password right after the first
  deploy: until `/setup` is completed, the first visitor can claim it.
- Secrets live only in `fly secrets`. Never commit `.env*` files; the
  `.gitignore` and `.dockerignore` deny them by default.
- Webhooks are authenticated by the vendor's signature, which is computed over
  `PUBLIC_BASE_URL`. Keep that value exact (https, no trailing slash).
