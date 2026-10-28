import type { Config } from "drizzle-kit";

import { env } from "~/env";

export default {
	schema: "./src/server/db/schema.ts",
	dialect: "sqlite",
	dbCredentials: {
		url: env.DATABASE_URL,
	},
	// The FTS5 search index (`drizzle/0005_conversations_fts.sql`) is a hand-
	// written virtual table with five shadow tables (`_data`, `_idx`, `_content`,
	// `_docsize`, `_config`). drizzle-kit does not model virtual tables, so
	// `db:push` reads them as "tables missing from schema.ts" and proposes to
	// DROP them (measured 2026-09-11: "You're about to delete
	// memo-call_conversations_fts_data table with 5 items"). The negation keeps
	// push away from them; the migrator owns that table.
	tablesFilter: ["memo-call_*", "!memo-call_conversations_fts*"],
} satisfies Config;
