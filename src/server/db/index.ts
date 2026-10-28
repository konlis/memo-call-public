import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { env } from "~/env";
import * as schema from "./schema";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
	client: Client | undefined;
};

export const client =
	globalForDb.client ?? createClient({ url: env.DATABASE_URL });
if (env.NODE_ENV !== "production") globalForDb.client = client;

// @libsql/client 0.14 defaults FK enforcement to OFF per connection — without this
// PRAGMA the schema's ON DELETE CASCADE clauses are silently dead. See CLAUDE.md
// "Critical product constraints → schema is multi-user-ready". Idempotent across HMR.
await client.execute("PRAGMA foreign_keys = ON;");

export const db = drizzle(client, { schema });
