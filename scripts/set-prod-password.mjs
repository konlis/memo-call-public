#!/usr/bin/env node
// Operator tool: set/reset the single user's login password by writing the
// bcrypt hash straight into `memo-call_auth_config` — WITHOUT the /setup wizard.
//
// Why this exists: the prod DB is a libsql file on the Fly volume
// (file:/data/db.sqlite), reachable only from inside the Machine, and the
// persona is the operator. This makes the change atomic (no "open /setup"
// account-hijack window) and keeps the plaintext password out of shell history
// (hidden prompt). Pure ESM with raw SQL + bcryptjs — NO TS imports — so it runs
// in the standalone prod image (which has node_modules but no src/ or tsx).
//
// Usage on prod (interactive, hidden prompt — preferred):
//   fly ssh console
//   node scripts/set-prod-password.mjs
//
// Usage locally / non-interactive (PASSWORD lands in shell history — less safe):
//   DATABASE_URL="file:./db.sqlite" PASSWORD="correct horse battery staple" \
//     node scripts/set-prod-password.mjs
//
// Unlike scripts/dev-seed-auth.mjs this is INTENDED for production, so it does
// NOT refuse NODE_ENV=production. It only ever touches user_id='me'.

import readline from "node:readline";
import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";

// Mirror src/server/auth/password.ts (work factor 12) and
// src/server/auth/password-rules.ts (>=12 chars OR >=4 space-separated words).
const WORK_FACTOR = 12;
function isValidPassword(p) {
	return p.length >= 12 || p.split(/\s+/).filter(Boolean).length >= 4;
}
const RULE_HINT =
	"Hasło: min. 12 znaków LUB min. 4 słowa oddzielone spacjami (np. „correct horse battery staple”).";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error(
		'[set-prod-password] DATABASE_URL jest wymagane (np. "file:/data/db.sqlite").',
	);
	process.exit(1);
}

/** Read a line from the TTY without echoing the typed characters. */
function promptHidden(query) {
	return new Promise((resolve, reject) => {
		if (!process.stdin.isTTY) {
			reject(new Error("no-tty"));
			return;
		}
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		process.stdout.write(query);
		rl.stdoutMuted = true;
		rl._writeToOutput = (s) => {
			if (!rl.stdoutMuted) rl.output.write(s);
		};
		rl.question("", (value) => {
			rl.output.write("\n");
			rl.close();
			resolve(value);
		});
	});
}

async function readPassword() {
	// Non-interactive fallback (local test / CI): take it from PASSWORD.
	if (process.env.PASSWORD) return process.env.PASSWORD;

	const first = await promptHidden("Nowe hasło: ");
	const second = await promptHidden("Powtórz hasło: ");
	if (first !== second) {
		console.error("[set-prod-password] Hasła nie są identyczne — przerywam.");
		process.exit(1);
	}
	return first;
}

try {
	console.log(`[set-prod-password] Cel: ${databaseUrl}`);
	const password = await readPassword().catch((err) => {
		if (err.message === "no-tty") {
			console.error(
				"[set-prod-password] Brak TTY na ukryty prompt. Uruchom interaktywnie przez `fly ssh console`, albo podaj PASSWORD=... (uwaga: trafia do historii).",
			);
			process.exit(1);
		}
		throw err;
	});

	if (!isValidPassword(password)) {
		console.error(`[set-prod-password] ${RULE_HINT}`);
		process.exit(1);
	}

	const client = createClient({ url: databaseUrl });
	// @libsql/client defaults FK enforcement OFF per connection; the upsert
	// references memo-call_users('me'), so FKs must be ON. Repo convention.
	await client.execute("PRAGMA foreign_keys = ON;");

	const hash = await bcrypt.hash(password, WORK_FACTOR);

	// Upsert on the PK (user_id). Also clears the FR-024 lockout counters so a
	// password reset never leaves the account in a locked state.
	const result = await client.execute({
		sql: `INSERT INTO "memo-call_auth_config" (user_id, password_hash, failed_attempts_count, last_failure_at)
		      VALUES ('me', ?, 0, NULL)
		      ON CONFLICT(user_id) DO UPDATE SET
		        password_hash = excluded.password_hash,
		        failed_attempts_count = 0,
		        last_failure_at = NULL`,
		args: [hash],
	});

	client.close();
	console.log(
		`[set-prod-password] OK — hasło ustawione dla user='me' (rowsAffected=${result.rowsAffected}). Istniejące sesje JWT żyją do wygaśnięcia; aby je unieważnić, zrotuj AUTH_SECRET.`,
	);
	process.exit(0);
} catch (err) {
	console.error("[set-prod-password] Błąd:", err);
	process.exit(1);
}
