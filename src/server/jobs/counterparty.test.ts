import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";

import { ProviderError } from "~/server/_lib/provider-error";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import { conversations } from "~/server/db/schema";
import { backfillConversation } from "~/server/jobs/backfill";
import {
	COUNTERPARTY_PENDING_TTL_MS,
	COUNTERPARTY_WINDOW_MS,
	type CounterpartySweepDeps,
	canonicalCounterpartyNumber,
	runCounterpartySweep,
} from "~/server/jobs/counterparty";
import type { CounterpartyResolution } from "~/server/telephony/types";

/**
 * The counterparty sweep (FR-025) on a REAL libsql database, per `lessons.md`:
 * the whole module is one `UPDATE … WHERE counterparty_state = 'pending'`
 * predicate plus a canonicalization step, and a stub db cannot tell you whether
 * that predicate does what the schema comment claims — which is the entire
 * privacy argument (no backfill of pre-FR-025 rows, no clobbering a terminal
 * state, no FTS wake-up).
 *
 * Numbers below are PLACEHOLDERS (this file lands in git history and in every
 * PR diff shipped to the CI reviewer). Their only job is to be greppable, so
 * the "nothing reaches the log" assertions can look for them.
 */

const DB_PATH = makeIntegrationDbPath("counterparty");
const DB_URL = `file:${DB_PATH}`;

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

const FIXED_NOW = new Date("2026-10-19T12:00:00.000Z");
const TTL_AGO = new Date(FIXED_NOW.getTime() - COUNTERPARTY_PENDING_TTL_MS);

/** The user's own GSM (`USER_FORWARD_NUMBER`) — must never be stored. */
const SELF = "+48500100300";
/** The other party, as the contact book would spell it. */
const COUNTERPARTY = "+48500100200";
/** The presentation name the vendor attached. */
const HINT = "Zenobia Testowa";

const SID_A = "in_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SID_B = "out_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SID_C = "in_cccccccccccccccccccccccccccccccccccccccc";

type Window = { since: Date; until: Date };

function makeDeps(
	resolve?: (input: Window) => Promise<CounterpartyResolution[]>,
): { deps: CounterpartySweepDeps; windows: Window[] } {
	const windows: Window[] = [];
	const telephony: CounterpartySweepDeps["telephony"] = {
		recordingContentType: "audio/wav",
		async streamRecording(_i, sink) {
			await sink.close();
		},
		async deleteRecording() {
			/* noop */
		},
	};
	if (resolve) {
		telephony.resolveCounterparties = async (input) => {
			windows.push({ since: input.since, until: input.until });
			return resolve(input);
		};
	}
	return {
		windows,
		deps: { db, telephony, userId: "me", now: () => FIXED_NOW },
	};
}

/** Deps whose provider answers with a fixed list and records the window. */
function answering(resolutions: CounterpartyResolution[]) {
	return makeDeps(async () => resolutions);
}

let seq = 0;
async function seedConversation(opts: {
	callSid: string;
	/** `undefined` → the column is left NULL, i.e. a pre-FR-025 row. */
	state?: schema.CounterpartyState;
	createdAt?: Date;
	e164?: string | null;
	nameHint?: string | null;
	transcript?: string;
}): Promise<string> {
	seq += 1;
	const id = `c-${seq}`;
	await db.insert(conversations).values({
		id,
		userId: "me",
		callSid: opts.callSid,
		recordingSid: `${opts.callSid}.rec`,
		counterpartyState: opts.state,
		counterpartyE164: opts.e164 ?? null,
		counterpartyNameHint: opts.nameHint ?? null,
		...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
		...(opts.transcript
			? {
					transcriptSegments: [
						{ speaker: "A", text: opts.transcript, startMs: 0, endMs: 1000 },
					],
				}
			: {}),
	});
	return id;
}

async function counterpartyOf(callSid: string) {
	const r = await client.execute({
		sql: 'SELECT counterparty_state AS state, counterparty_e164 AS e164, counterparty_name_hint AS hint FROM "memo-call_conversations" WHERE call_sid = ?',
		args: [callSid],
	});
	const row = r.rows[0];
	return row ? { state: row.state, e164: row.e164, hint: row.hint } : undefined;
}

async function ftsMatches(phrase: string): Promise<number> {
	const r = await client.execute({
		sql: 'SELECT count(*) AS n FROM "memo-call_conversations_fts" WHERE "memo-call_conversations_fts" MATCH ?',
		args: [phrase],
	});
	return Number(r.rows[0]?.n ?? 0);
}

function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => {
		lines.push(String(l));
	});
	return { lines, restore: () => spy.mockRestore() };
}

function events(lines: string[], event: string) {
	return lines
		.map((l) => JSON.parse(l) as Record<string, unknown>)
		.filter((l) => l.event === event);
}

async function sweep(
	deps: CounterpartySweepDeps,
	opts: { selfNumber?: string } = { selfNumber: SELF },
) {
	const { lines, restore } = captureStderr();
	try {
		await runCounterpartySweep(deps, opts);
	} finally {
		restore();
	}
	return {
		lines,
		run: events(lines, "telephony.counterparty.sweep")[0],
		failed: events(lines, "telephony.counterparty.failed")[0],
	};
}

beforeAll(async () => {
	cleanupIntegrationDb(DB_PATH);
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
});

afterAll(() => {
	client?.close();
	cleanupIntegrationDb(DB_PATH);
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_processing_jobs"');
	await client.execute('DELETE FROM "memo-call_conversations"');
});

describe("canonicalCounterpartyNumber", () => {
	test("spells a Polish number exactly as the contact book does", () => {
		for (const raw of [
			"48500100200",
			"500100200",
			"+48500100200",
			"0048500100200",
		]) {
			expect(canonicalCounterpartyNumber(raw)).toBe("+48500100200");
		}
	});

	test("keeps a foreign number as `+` + digits", () => {
		expect(canonicalCounterpartyNumber("+14155550100")).toBe("+14155550100");
		expect(canonicalCounterpartyNumber("14155550100")).toBe("+14155550100");
	});

	test("returns null for a digitless value (disables the self-check, never throws)", () => {
		expect(canonicalCounterpartyNumber("")).toBeNull();
		expect(canonicalCounterpartyNumber("not a number")).toBeNull();
	});
});

describe("runCounterpartySweep — the three terminal outcomes", () => {
	test("known: writes the canonical number and the hint onto the pending row", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps, windows } = answering([
			{
				callSid: SID_A,
				outcome: "known",
				// The mapper hands over `+`-or-nothing + digits; canonical form is
				// decided HERE, so the join to `contacts.e164` is byte-exact.
				rawNumber: "48500100200",
				nameHint: HINT,
			},
		]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "known",
			e164: COUNTERPARTY,
			hint: HINT,
		});
		expect(run).toMatchObject({
			pending: 1,
			resolved: 1,
			withheld: 0,
			expired: 0,
			selfRefused: 0,
			unmatched: 0,
		});
		// The window: 48 h back from now, NO near-end grace.
		expect(windows).toHaveLength(1);
		expect(windows[0]?.until.getTime()).toBe(FIXED_NOW.getTime());
		expect(windows[0]?.since.getTime()).toBe(
			FIXED_NOW.getTime() - COUNTERPARTY_WINDOW_MS,
		);
	});

	test("known without a hint leaves the hint NULL; a foreign number keeps its country code", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "+14155550100" },
		]);

		await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "known",
			e164: "+14155550100",
			hint: null,
		});
	});

	test("withheld: terminal state, number and hint NULL", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = answering([{ callSid: SID_A, outcome: "withheld" }]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "withheld",
			e164: null,
			hint: null,
		});
		expect(run).toMatchObject({ pending: 1, withheld: 1, resolved: 0 });
	});

	test("unparsed: vendor format drift writes NOTHING, stays pending, and is counted apart from unmatched", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = answering([{ callSid: SID_A, outcome: "unparsed" }]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "pending",
			e164: null,
			hint: null,
		});
		expect(run).toMatchObject({
			pending: 1,
			unparsed: 1,
			unmatched: 0,
			withheld: 0,
			resolved: 0,
		});
	});

	test("unmatched: a pending row with no resolution stays pending for the next sweep", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = answering([]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "pending",
			e164: null,
			hint: null,
		});
		expect(run).toMatchObject({ pending: 1, unmatched: 1, resolved: 0 });
	});
});

describe("runCounterpartySweep — expiry", () => {
	test("a pending row older than 24 h becomes unavailable, and is no longer asked about", async () => {
		await seedConversation({
			callSid: SID_A,
			state: "pending",
			createdAt: new Date(TTL_AGO.getTime() - 60_000),
		});
		await seedConversation({
			callSid: SID_B,
			state: "pending",
			createdAt: new Date(TTL_AGO.getTime() + 60_000),
		});
		// The provider knows BOTH. The expired one must not be written anyway:
		// expiry runs first, and the write predicate requires `pending`.
		const { deps } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "48500100200" },
			{ callSid: SID_B, outcome: "known", rawNumber: "48500100200" },
		]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "unavailable",
			e164: null,
			hint: null,
		});
		expect(await counterpartyOf(SID_B)).toMatchObject({ state: "known" });
		expect(run).toMatchObject({
			expired: 1,
			pending: 1, // counted AFTER expiry
			resolved: 1,
			unmatched: 0,
		});
	});

	test("expiry never touches a terminal or a pre-FR-025 row, however old", async () => {
		const ancient = new Date("2026-01-01T00:00:00.000Z");
		await seedConversation({ callSid: SID_A, createdAt: ancient }); // NULL
		await seedConversation({
			callSid: SID_B,
			state: "known",
			e164: COUNTERPARTY,
			createdAt: ancient,
		});
		await seedConversation({
			callSid: SID_C,
			state: "withheld",
			createdAt: ancient,
		});
		const { deps } = answering([]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toMatchObject({ state: null });
		expect(await counterpartyOf(SID_B)).toMatchObject({
			state: "known",
			e164: COUNTERPARTY,
		});
		expect(await counterpartyOf(SID_C)).toMatchObject({ state: "withheld" });
		expect(run).toMatchObject({ expired: 0, pending: 0 });
	});
});

describe("runCounterpartySweep — self-refusal (pre-mortem #1 as a counter)", () => {
	test("a candidate equal to the user's own GSM is REFUSED: unavailable, never stored, counted", async () => {
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{
				callSid: SID_B,
				outcome: "known",
				rawNumber: "48500100300",
				nameHint: "Me",
			},
		]);

		const { run, lines } = await sweep(deps, { selfNumber: SELF });

		expect(await counterpartyOf(SID_B)).toEqual({
			state: "unavailable",
			e164: null,
			hint: null,
		});
		expect(run).toMatchObject({ selfRefused: 1, resolved: 0, unmatched: 0 });
		expect(lines.join("\n")).not.toContain("500100300");
	});

	test("the own GSM on an INBOUND call is not the alarm: unavailable, never stored, counted as selfInbound", async () => {
		// A call FROM the user's own GSM to their own DID (a voice memo) is
		// legitimate; only an outbound leg resolving to the own number means the
		// leg rule is wrong (full-plan impl-review F5).
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{
				callSid: SID_B,
				outcome: "known",
				rawNumber: "48500100300",
				direction: "inbound",
			},
		]);

		const { run } = await sweep(deps, { selfNumber: SELF });

		expect(await counterpartyOf(SID_B)).toEqual({
			state: "unavailable",
			e164: null,
			hint: null,
		});
		expect(run).toMatchObject({ selfRefused: 0, selfInbound: 1, resolved: 0 });
	});

	test("matches the own number through canonicalization, however the operator spelled it", async () => {
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{ callSid: SID_B, outcome: "known", rawNumber: "+48500100300" },
		]);

		const { run } = await sweep(deps, { selfNumber: "500 100 300" });

		expect(await counterpartyOf(SID_B)).toMatchObject({
			state: "unavailable",
		});
		expect(run).toMatchObject({ selfRefused: 1 });
	});

	test("no own number configured → the check is skipped, not an error", async () => {
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{ callSid: SID_B, outcome: "known", rawNumber: "48500100300" },
		]);

		const { run, failed } = await sweep(deps, { selfNumber: undefined });

		expect(failed).toBeUndefined();
		expect(await counterpartyOf(SID_B)).toMatchObject({
			state: "known",
			e164: SELF,
		});
		expect(run).toMatchObject({ resolved: 1, selfRefused: 0 });
	});
});

describe("runCounterpartySweep — the write predicate", () => {
	test("a known row is never overwritten by a later resolution", async () => {
		await seedConversation({
			callSid: SID_A,
			state: "known",
			e164: COUNTERPARTY,
			nameHint: HINT,
		});
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "+14155550100" },
			{ callSid: SID_B, outcome: "known", rawNumber: "+14155550100" },
		]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: "known",
			e164: COUNTERPARTY,
			hint: HINT,
		});
		expect(await counterpartyOf(SID_B)).toMatchObject({
			e164: "+14155550100",
		});
		expect(run).toMatchObject({ pending: 1, resolved: 1 });
	});

	test("a pre-FR-025 row (state NULL) NEVER changes, even when the provider names it — no backfill", async () => {
		await seedConversation({ callSid: SID_A }); // NULL state
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{
				callSid: SID_A,
				outcome: "known",
				rawNumber: "48500100200",
				nameHint: HINT,
			},
			{ callSid: SID_B, outcome: "withheld" },
		]);

		await sweep(deps);

		expect(await counterpartyOf(SID_A)).toEqual({
			state: null,
			e164: null,
			hint: null,
		});
		expect(await counterpartyOf(SID_B)).toMatchObject({ state: "withheld" });
	});

	test("a second sweep over the same window changes nothing and makes no request", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps, windows } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "48500100200" },
		]);

		await sweep(deps);
		const second = await sweep(deps);

		expect(windows).toHaveLength(1); // no pending → no vendor request
		expect(second.run).toMatchObject({
			pending: 0,
			resolved: 0,
			unmatched: 0,
		});
		expect(await counterpartyOf(SID_A)).toMatchObject({ state: "known" });
	});

	test("a resolution for a call we do not know is ignored and not counted", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = answering([
			{ callSid: SID_C, outcome: "known", rawNumber: "48500100200" },
		]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toMatchObject({ state: "pending" });
		expect(run).toMatchObject({ pending: 1, resolved: 0, unmatched: 1 });
	});

	test("a duplicate resolution for one call counts once", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "48500100200" },
			{ callSid: SID_A, outcome: "known", rawNumber: "+14155550100" },
		]);

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toMatchObject({ e164: COUNTERPARTY });
		expect(run).toMatchObject({ resolved: 1, unmatched: 0 });
	});

	test("scopes every read and write to the given userId", async () => {
		// A row that belongs to NOBODY we sweep for must be invisible — the
		// multi-user-ready invariant in CLAUDE.md, pinned where it would silently
		// fail otherwise.
		await client.execute({
			sql: 'INSERT INTO "memo-call_users" (id) VALUES (?)',
			args: ["someone-else"],
		});
		await client.execute({
			sql: 'INSERT INTO "memo-call_conversations" (id, user_id, call_sid, counterparty_state) VALUES (?, ?, ?, ?)',
			args: ["c-other", "someone-else", SID_A, "pending"],
		});
		const { deps, windows } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "48500100200" },
		]);

		const { run } = await sweep(deps);

		expect(windows).toHaveLength(0); // nothing pending for `me` → no request
		expect(run).toMatchObject({ pending: 0 });
		expect(await counterpartyOf(SID_A)).toMatchObject({
			state: "pending",
			e164: null,
		});
		await client.execute({
			sql: 'DELETE FROM "memo-call_users" WHERE id = ?',
			args: ["someone-else"],
		});
	});
});

describe("runCounterpartySweep — a provider without the capability", () => {
	test("only expires; makes no request; is silent when nothing expired", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = makeDeps(); // no resolveCounterparties

		const { lines } = await sweep(deps);

		expect(lines).toEqual([]);
		expect(await counterpartyOf(SID_A)).toMatchObject({ state: "pending" });
	});

	test("reports a run line when the expiry DID change something", async () => {
		await seedConversation({
			callSid: SID_A,
			state: "pending",
			createdAt: new Date(TTL_AGO.getTime() - 60_000),
		});
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = makeDeps();

		const { run } = await sweep(deps);

		expect(await counterpartyOf(SID_A)).toMatchObject({
			state: "unavailable",
		});
		expect(await counterpartyOf(SID_B)).toMatchObject({ state: "pending" });
		expect(run).toMatchObject({ expired: 1, pending: 1, unmatched: 1 });
	});
});

describe("runCounterpartySweep — nothing pending", () => {
	test("makes no vendor request and still emits the run line", async () => {
		await seedConversation({
			callSid: SID_A,
			state: "known",
			e164: COUNTERPARTY,
		});
		const { deps, windows } = answering([
			{ callSid: SID_A, outcome: "known", rawNumber: "+14155550100" },
		]);

		const { run } = await sweep(deps);

		expect(windows).toHaveLength(0);
		expect(run).toMatchObject({ pending: 0, resolved: 0, expired: 0 });
	});
});

describe("runCounterpartySweep — the insert path", () => {
	test("backfillConversation inserts `pending` with NO number and NO hint", async () => {
		const jobId = await backfillConversation(db, {
			userId: "me",
			callSid: SID_A,
			recordingSid: `${SID_A}.rec`,
		});
		expect(jobId).not.toBeNull();
		expect(await counterpartyOf(SID_A)).toEqual({
			state: "pending",
			e164: null,
			hint: null,
		});
	});
});

describe("runCounterpartySweep — search is unaffected", () => {
	test("writing the number and hint wakes no FTS trigger: same hits before and after, number not searchable", async () => {
		await seedConversation({
			callSid: SID_A,
			state: "pending",
			transcript: "Faktura za listopad do zapłaty",
		});
		expect(await ftsMatches("faktura")).toBe(1);
		const { deps } = answering([
			{
				callSid: SID_A,
				outcome: "known",
				rawNumber: "48500100200",
				nameHint: HINT,
			},
		]);

		await sweep(deps);

		expect(await counterpartyOf(SID_A)).toMatchObject({ e164: COUNTERPARTY });
		expect(await ftsMatches("faktura")).toBe(1);
		expect(await ftsMatches("500100200")).toBe(0);
		expect(await ftsMatches("Zenobia")).toBe(0);
		// Exactly one index row for the conversation — the update did not
		// re-fire the DELETE + INSERT the transcript/analysis path uses.
		const r = await client.execute(
			'SELECT count(*) AS n FROM "memo-call_conversations_fts"',
		);
		expect(Number(r.rows[0]?.n)).toBe(1);
	});
});

describe("runCounterpartySweep — nothing reaches the log", () => {
	test("a successful run prints counters only — no call id, no number, no hint", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		await seedConversation({ callSid: SID_B, state: "pending" });
		const { deps } = answering([
			{
				callSid: SID_A,
				outcome: "known",
				rawNumber: "48500100200",
				nameHint: HINT,
			},
			{ callSid: SID_B, outcome: "withheld" },
		]);

		const { lines, run } = await sweep(deps);

		expect(lines).toHaveLength(1);
		expect(Object.keys(run ?? {}).sort()).toEqual([
			"event",
			"expired",
			"pending",
			"resolved",
			"selfInbound",
			"selfRefused",
			"ts",
			"unmatched",
			"unparsed",
			"withheld",
		]);
		const joined = lines.join("\n");
		expect(joined).not.toContain("500100200");
		expect(joined).not.toContain(HINT);
		expect(joined).not.toContain(SID_A);
	});

	test("a ProviderError is logged with its code, never escapes, and produces no run line", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps } = makeDeps(async () => {
			throw new ProviderError({
				code: "transport",
				message: "zadarma unreachable",
			});
		});

		const { failed, run } = await sweep(deps);

		expect(failed).toMatchObject({
			errorCode: "transport",
			error: "zadarma unreachable",
		});
		expect(run).toBeUndefined();
		expect(await counterpartyOf(SID_A)).toMatchObject({ state: "pending" });
	});

	test("a failed UPDATE whose message carries the bound values is redacted before it is logged", async () => {
		await seedConversation({ callSid: SID_A, state: "pending" });
		const { deps: base } = answering([
			{
				callSid: SID_A,
				outcome: "known",
				rawNumber: "48500100200",
				nameHint: HINT,
			},
		]);
		// The shape `DrizzleQueryError` (drizzle-orm 0.45) actually produces: the
		// statement, then a `params:` tail with every bound value — i.e. the
		// number AND the name. Thrown from the write so the sweep's own catch
		// sees it. A Proxy, not a spread: the drizzle db is a class instance.
		let updates = 0;
		const failing = new Proxy(base.db, {
			get(target, prop, receiver) {
				if (prop !== "update") return Reflect.get(target, prop, receiver);
				return (...args: unknown[]) => {
					updates += 1;
					if (updates === 2) {
						throw new Error(
							`Failed query: update "memo-call_conversations" set "counterparty_e164" = ?, "counterparty_name_hint" = ?\nparams: ${COUNTERPARTY},${HINT}`,
						);
					}
					return (target.update as (...a: unknown[]) => unknown)(...args);
				};
			},
		}) as typeof base.db;

		const { failed, lines } = await sweep({ ...base, db: failing });

		expect(updates).toBe(2); // expiry UPDATE, then the write that failed
		expect(failed).toBeDefined();
		const joined = lines.join("\n");
		expect(joined).not.toContain("500100200");
		expect(joined).not.toContain(HINT);
		expect(joined).not.toContain("params:");
	});
});
