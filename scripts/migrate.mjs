#!/usr/bin/env node
// Runtime migrator for production (Fly release_command) and local verification.
// Reads DATABASE_URL from env, opens a libsql client, applies any pending
// migrations from ./drizzle/. Forward-only; failure exits non-zero so Fly aborts
// the deploy (the running Machine keeps serving). See plan.md F-01 Phase 2 §2.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("[migrate] DATABASE_URL is required");
	process.exit(1);
}

try {
	const client = createClient({ url: databaseUrl });
	// @libsql/client 0.14 defaults FK enforcement to OFF per connection.
	// Drizzle's libsql migrator toggles FKs off during DDL and restores on
	// completion, so this PRAGMA doesn't change migration behavior — it
	// documents the codebase convention at the moment the connection opens.
	// See CLAUDE.md "Critical product constraints → schema is multi-user-ready".
	await client.execute("PRAGMA foreign_keys = ON;");

	await migrate(drizzle(client), { migrationsFolder: "drizzle" });

	console.log("[migrate] Migrations applied");
	process.exit(0);
} catch (err) {
	console.error("[migrate] Failed:", err);
	process.exit(1);
}
