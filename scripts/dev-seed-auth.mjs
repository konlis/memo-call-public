#!/usr/bin/env node
// Dev-only seeder for the `memo-call_auth_config` password row. Lets Phase 2's
// manual verification (login flow) run BEFORE the Phase 3 setup wizard exists.
// Imports the just-shipped TypeScript `hashPassword`, so run it through tsx:
//
//   DATABASE_URL="file:./db.sqlite" PASSWORD="test-12-char-pwd" \
//     npx tsx scripts/dev-seed-auth.mjs
//
// Stays in scripts/ after Phase 3 as a "wipe and reseed local password" tool.
// NOT used in production — the wizard owns first-run password set there.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { hashPassword } from "../src/server/auth/password.ts";
import { authConfig } from "../src/server/db/schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error(
		'[dev-seed-auth] DATABASE_URL is required (e.g. "file:./db.sqlite")',
	);
	process.exit(1);
}

// Defence-in-depth: this script does a DESTRUCTIVE upsert (overwrites the
// password hash + resets lockout state). Refuse to run against production or a
// remote DB so an operator can't reset the real login from the wrong shell.
// NB: Fly prod is ALSO a file: URL (file:/data/db.sqlite), so the file: check
// alone can't distinguish prod — NODE_ENV is the real guard (Fly sets it).
if (process.env.NODE_ENV === "production") {
	console.error("[dev-seed-auth] refusing to run with NODE_ENV=production");
	process.exit(1);
}
if (!databaseUrl.startsWith("file:")) {
	console.error(
		"[dev-seed-auth] refusing: DATABASE_URL must be a local file: URL (got a remote/non-file URL)",
	);
	process.exit(1);
}

const password = process.env.PASSWORD;
if (!password) {
	console.error("[dev-seed-auth] PASSWORD is required");
	process.exit(1);
}

try {
	const client = createClient({ url: databaseUrl });
	// @libsql/client defaults FK enforcement to OFF per connection — the upsert
	// references memo-call_users('me'), so FKs must be ON. Repo convention.
	await client.execute("PRAGMA foreign_keys = ON;");

	const hash = await hashPassword(password);

	await drizzle(client)
		.insert(authConfig)
		.values({ userId: "me", passwordHash: hash, failedAttemptsCount: 0 })
		.onConflictDoUpdate({
			target: authConfig.userId,
			set: { passwordHash: hash, failedAttemptsCount: 0, lastFailureAt: null },
		});

	console.log("[dev-seed-auth] seeded auth_config for user='me'");
	process.exit(0);
} catch (err) {
	console.error("[dev-seed-auth] Failed:", err);
	process.exit(1);
}
