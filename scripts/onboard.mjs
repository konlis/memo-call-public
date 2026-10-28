#!/usr/bin/env node
// Operator onboarding tool (deliverable #2 of `operator-onboarding-tooling`).
//
// Spins up client #N in the deployment-model-A fleet (one repo, N isolated
// single-tenant Fly apps). It reads a per-client config, validates the
// EU-residency / format footguns BEFORE anything is set, and prints the exact,
// correctly-ordered `fly secrets set` commands + the vendor-console steps the
// operator must perform by hand. It NEVER executes `fly` — advise only (the
// print/validate seam is where a future `--execute` would hook in).
//
// TELEPHONY IS A CHOICE, NOT A CONSTANT. `TELEPHONY_PROVIDER` (zadarma|twilio)
// selects which credentials are required, which flip is emitted, and which
// panel steps are printed. It used to be hardcoded to `twilio` in the command
// builder, which after `telephony-provider-zadarma` meant this tool confidently
// handed a new fleet instance the credential block of the provider the project
// had migrated OFF — with the full "validated before anything is set" ceremony
// that makes it believable. There is deliberately NO default.
//
// The pure logic lives in scripts/onboard/lib.mjs (unit-tested); this file is
// the thin imperative shell (input + printing). Mirrors the script convention
// in scripts/set-prod-password.mjs: pure ESM, Polish messages, `[onboard]`
// prefix, hidden-TTY prompt, fail-loud guards, process.exit codes.
//
// Usage:
//   1. cp .env.onboard.example .env.onboard.local   (auto-gitignored)
//   2. fill .env.onboard.local with the client's values
//   3. node scripts/onboard.mjs            # validate + print commands
//      node scripts/onboard.mjs --smoke    # + read-only vendor pre-flight (Phase 3)
//   4. paste the printed `fly secrets set` block (in order) into the Fly app
//
// Any required field missing from the file is asked via a hidden TTY prompt;
// with no TTY and an incomplete file the tool fails fast (exit 1) rather than
// hang — CI-friendly.

import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
	buildSecretCommands,
	buildWebhookInstructions,
	CONFIG_KEYS,
	OPTIONAL_KEYS,
	requiredKeys,
	validateConfig,
} from "./onboard/lib.mjs";

const ENV_FILENAME = ".env.onboard.local";
const ENV_PATH = path.resolve(process.cwd(), ENV_FILENAME);

const runSmoke = process.argv.includes("--smoke");

/**
 * Parse a `.env.onboard.local`-style file: `KEY=value` lines, `#` comments and
 * blanks ignored, surrounding single/double quotes stripped. Returns `{}` if
 * the file is absent (the prompts then fill every field).
 *
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
	/** @type {Record<string, string>} */
	const out = {};
	let raw;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return out; // absent → empty; prompts fill the gaps
	}
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

/** Read a line from the TTY without echoing typed characters. */
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
			resolve(value.trim());
		});
	});
}

/**
 * Build the config: start from the file, then prompt (hidden) for any REQUIRED
 * key still missing. Optional keys are taken from the file only (never prompted).
 *
 * @returns {Promise<Record<string, string>>}
 */
async function readConfig() {
	const fromFile = parseEnvFile(ENV_PATH);
	/** @type {Record<string, string>} */
	const cfg = {};

	// Carry over every recognized key present in the file (required + optional).
	for (const key of [...CONFIG_KEYS, ...OPTIONAL_KEYS]) {
		if (fromFile[key]?.trim()) cfg[key] = fromFile[key].trim();
	}

	// Prompt for required keys still missing. The required set depends on
	// TELEPHONY_PROVIDER, so a Zadarma operator is never asked for a Twilio SID
	// they do not have — an unsatisfiable prompt with no way out but Ctrl-C.
	// If the provider itself is missing, ask for it FIRST so the rest of the
	// prompt list is the right one.
	if (!cfg.TELEPHONY_PROVIDER) {
		console.log(
			`[onboard] Brak TELEPHONY_PROVIDER w ${ENV_FILENAME} — od niego zależy, o które sekrety telefonii zapytam.`,
		);
		cfg.TELEPHONY_PROVIDER = await promptHidden(
			"  TELEPHONY_PROVIDER (zadarma | twilio): ",
		);
	}
	const missing = requiredKeys(cfg).filter((k) => !cfg[k]);
	if (missing.length > 0) {
		console.log(
			`[onboard] ${missing.length} pól brakuje w ${ENV_FILENAME} — podaj je teraz (ukryte):`,
		);
		for (const key of missing) {
			cfg[key] = await promptHidden(`  ${key}: `);
		}
	}
	return cfg;
}

async function main() {
	console.log(`[onboard] Źródło konfiguracji: ${ENV_PATH}`);

	let cfg;
	try {
		cfg = await readConfig();
	} catch (err) {
		if (err?.message === "no-tty") {
			console.error(
				`[onboard] Brak TTY na ukryty prompt, a ${ENV_FILENAME} nie zawiera wszystkich wymaganych pól. Uzupełnij plik (cp .env.onboard.example ${ENV_FILENAME}) albo uruchom interaktywnie.`,
			);
			process.exit(1);
		}
		throw err;
	}

	const { ok, errors } = validateConfig(cfg);
	if (!ok) {
		console.error(
			`[onboard] Konfiguracja odrzucona (${errors.length} błędów) — nic nie zostało ustawione:`,
		);
		for (const e of errors) {
			console.error(`  ✖ ${e.field}: ${e.message}`);
		}
		process.exit(1);
	}

	// Read-only pre-flight smoke (opt-in). Lazy-imported so the plain advise
	// path never loads the Bedrock SDK and does no network I/O. A failed probe
	// is a warning — we still print the commands (the operator may knowingly
	// proceed) — but the process exit code reflects the smoke result.
	let smokeAllOk = true;
	if (runSmoke) {
		const { runSmoke: runSmokeChecks } = await import("./onboard/smoke.mjs");
		const { results, allOk } = await runSmokeChecks(cfg);
		smokeAllOk = allOk;
		console.log(
			"\n[onboard] Pre-flight smoke (read-only, nic nie jest zapisywane):",
		);
		for (const r of results) {
			console.log(`  ${r.ok ? "✅" : "❌"} ${r.label}: ${r.reason}`);
		}
		if (!allOk) {
			console.error(
				"[onboard] ⚠ Co najmniej jedna sonda zawiodła — komendy poniżej nadal drukuję, ale popraw przyczynę przed wdrożeniem.",
			);
		}
	}

	const commands = buildSecretCommands(cfg);
	console.log(
		"\n[onboard] Konfiguracja poprawna ✅ Uruchom poniższe komendy w katalogu aplikacji Fly W TEJ KOLEJNOŚCI",
	);
	console.log(
		"          (każdy przełącznik *_PROVIDER celowo następuje PO swoich sekretach):\n",
	);
	// Caution goes to stderr so stdout stays a clean copy-paste block.
	console.error(
		"[onboard] ⚠ UWAGA: poniższe komendy zawierają sekrety w postaci jawnej — nie loguj ich, nie udostępniaj ekranu, wyczyść historię terminala po wklejeniu.",
	);
	commands.forEach((cmd, i) => {
		console.log(`  ${i + 1}) ${cmd}`);
	});

	// The enum-before-secret ordering is between `fly deploy` and the block
	// above, so `buildSecretCommands` structurally cannot express it — it is
	// printed as prose instead. Setting TELEPHONY_PROVIDER on an image whose
	// `src/env.js` enum predates the value crash-loops the Machine on env
	// validation (the Deepgram cutover hit exactly this; see CLAUDE.md "Lessons").
	console.log(
		"\n[onboard] ⚠ ZANIM wkleisz blok: upewnij się, że wdrożony obraz zna wartość " +
			`TELEPHONY_PROVIDER="${cfg.TELEPHONY_PROVIDER}" (enum w src/env.js). ` +
			"Jeśli nie — najpierw `fly deploy`, dopiero potem sekrety. Odwrotna kolejność " +
			"restartuje STARY obraz, który pada na walidacji env i crash-loopuje.",
	);

	const { lines } = buildWebhookInstructions(cfg);
	console.log(
		`\n[onboard] Kroki do wykonania RĘCZNIE w panelu dostawcy (${cfg.TELEPHONY_PROVIDER}) — narzędzie nic tam nie zapisuje:`,
	);
	for (const line of lines) {
		console.log(`  ${line}`);
	}
	process.exit(smokeAllOk ? 0 : 1);
}

main().catch((err) => {
	console.error("[onboard] Błąd:", err);
	process.exit(1);
});
