import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { safeErrorMessage } from "~/server/_lib/redact";
import { auth } from "~/server/auth";
import { logAuthEvent } from "~/server/auth/audit";
import { db } from "~/server/db";
import { authConfig } from "~/server/db/schema";

// Next.js 16 route gate. The file is `proxy.ts` (NOT `middleware.ts`) and runs
// on the Node runtime. See CLAUDE.md "Authentication (F-03)".
//
// LOCATION: this MUST live at `src/proxy.ts` for this project, NOT the repo
// root. Next.js detects the proxy/middleware file by globbing `dirname(appDir)`
// — for a `src/app` project that is `src/`. A repo-root `proxy.ts` is SILENTLY
// IGNORED (build stays green, manifest empty, no gate).
//
// Unauthenticated requests are routed to `/setup` until the first-run password
// exists, then to `/login` (Phase 3 branch). The DB read fires ONLY for
// unauthenticated requests — authenticated ones short-circuit at `req.auth`
// with no DB hit. The query is a sub-ms libsql read on the local Volume.
export const proxy = auth(async (req) => {
	if (req.auth) return; // authenticated → allow through, no DB hit

	// Fail CLOSED to /login: this handler gates nearly every route, so an
	// unhandled throw here would 500 the whole app for logged-out visitors.
	// /login renders with NO DB read, so it stays reachable even when the
	// auth_config query below fails (SQLITE_BUSY, a mid-deploy "no such table"
	// race, or a db-init rejection). Worst case the user lands on /login on a
	// fresh install instead of /setup — recoverable, never a 500.
	let target = "/login";
	try {
		const row = await db.query.authConfig.findFirst({
			where: eq(authConfig.userId, "me"),
		});
		target = row?.passwordHash ? "/login" : "/setup";
	} catch (error) {
		logAuthEvent("proxy_db_error", {
			error: safeErrorMessage(error),
		});
	}

	const url = new URL(target, req.nextUrl.origin);
	if (target === "/login") {
		// Same-origin relative pathname only — the login form re-validates it via
		// safeCallbackUrl() before navigating.
		url.searchParams.set("callbackUrl", req.nextUrl.pathname);
	}
	return NextResponse.redirect(url);
});

// Gate everything EXCEPT the intended exclusions below.
//
// ANCHORING, precisely — the earlier wording here claimed "each token is
// anchored", which is false and was corrected in the phase-3 impl review (F6).
// Alternation binds loosest, so `(?:/|$)` attaches ONLY to the first group:
//
//   (?: login|setup|api/auth|api/trpc|api/telephony )(?:/|$)   ← anchored
//   | _next/static | _next/image | favicon\.ico | public/       ← NOT anchored
//
// So the five ROUTE tokens are anchored, and a future route that merely starts
// with one (`/login-history`, `/api/authorize-device`, `/api/telephony-admin`)
// stays gated — that is the property worth having, and `proxy.test.ts` pins it.
// The four STATIC-ASSET tokens are deliberately left as bare prefixes: they are
// not routes, so `/favicon.ico.txt` and `/_next/staticfoo` fall outside the gate
// (measured, also pinned) without exposing anything — there is nothing there to
// serve. `/publicfoo` happens to stay gated because `public/` carries its own
// trailing slash, NOT because of the anchor. Add a new ROUTE token to the first
// group; anything added to the tail is an unanchored prefix.
// Intended exclusions:
//   - `/login`, `/setup`, `/api/auth/*` — the auth surface (handles its own auth)
//   - `/api/trpc/*` — tRPC procedures self-enforce via `protectedProcedure`;
//     double-gating here only adds latency + a second failure mode
//   - `/api/telephony/*` — inbound telephony webhooks (S-01; renamed off the
//     vendor's name in `telephony-provider-zadarma`). ONE token covers all three
//     handlers under the prefix (`voice`, `recording-status`, `events`). The
//     provider is unauthenticated (no session); the signature check IS the auth,
//     enforced inside `server/telephony/webhooks.ts` against the header name the
//     configured provider declares — which header that is depends on the vendor,
//     so naming one here would be wrong as soon as the secret is flipped. Without
//     this exclusion the gate would 307-redirect the provider's POST to `/login`
//     and the webhook would never fire — a total capture outage visible only in
//     the vendor's own console.
//   - `_next/static`, `_next/image`, `favicon.ico`, `public/` — static assets
export const config = {
	matcher: [
		"/((?!(?:login|setup|api/auth|api/trpc|api/telephony)(?:/|$)|_next/static|_next/image|favicon\\.ico|public/).*)",
	],
};
