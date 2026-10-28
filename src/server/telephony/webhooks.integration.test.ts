import { createHmac } from "node:crypto";

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
} from "vitest";
import {
	cleanupIntegrationDb,
	makeIntegrationDbPath,
} from "~/server/db/integration-test-db";
import * as schema from "~/server/db/schema";
import { MockTelephonyProvider } from "~/server/telephony/mock";
import {
	handleRecordingStatus,
	type RecordingStatusDeps,
} from "~/server/telephony/webhooks";
import { ZadarmaTelephonyProvider } from "~/server/telephony/zadarma";

// Real-libsql integration test. The stub-db unit tests in webhooks.test.ts cover
// the handler's BRANCHING, but cannot exercise the actual `ON CONFLICT DO NOTHING`
// SQL — which is exactly where the partial-index idempotency bug hid (drizzle
// emitted `do nothing where …`, rejected by SQLite). This test applies the real
// migrations to a throwaway DB and drives the handler end-to-end so that class of
// failure surfaces in CI, per CLAUDE.md "Lessons" ("a green unit test ≠ real SQL").
const DB_PATH = makeIntegrationDbPath("webhooks");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let deps: Omit<RecordingStatusDeps, "telephony"> & {
	telephony: MockTelephonyProvider;
};

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	const db = drizzle(client, { schema });
	deps = {
		telephony: new MockTelephonyProvider(),
		db,
		publicBaseUrl: "https://your-app.fly.dev",
		userId: "me",
	};
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	// Each test starts from an empty pipeline (the seeded users('me') row stays).
	await client.execute('DELETE FROM "memo-call_processing_jobs"');
	await client.execute('DELETE FROM "memo-call_conversations"');
	await client.execute('DELETE FROM "memo-call_reconcile_tombstones"');
});

function completedRequest(callSid: string): Request {
	return new Request(
		"https://your-app.fly.dev/api/telephony/recording-status",
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-twilio-signature": "mock-valid",
			},
			body: new URLSearchParams({
				CallSid: callSid,
				RecordingSid: `RE_${callSid}`,
				RecordingStatus: "completed",
				RecordingDuration: "7",
			}).toString(),
		},
	);
}

async function counts() {
	const c = await client.execute(
		'SELECT count(*) AS n FROM "memo-call_conversations"',
	);
	const j = await client.execute(
		'SELECT count(*) AS n FROM "memo-call_processing_jobs"',
	);
	return {
		conversations: Number(c.rows[0]?.n ?? 0),
		jobs: Number(j.rows[0]?.n ?? 0),
	};
}

/**
 * The Zadarma half of criterion 3.7, deliberately driven against the REAL
 * provider rather than a stub.
 *
 * A stub `verifySignature` accepts (or refuses) whatever the test tells it to, so
 * "a non-recording event writes nothing" passes against one no matter which
 * ordering the handler uses — the criterion would be green while the defect
 * shipped. The real provider is what makes the assertion load-bearing: its
 * `verifySignature` is fail-closed for the seven ordinary lifecycle events
 * (their signed field set is not documented, so it CANNOT verify them), which is
 * exactly why the handler must decide "not actionable" before it asks about
 * authorization. Get the order wrong and the first test below is a 403 instead of
 * a 200 — the 403-on-every-call storm FU-3 exists to prevent.
 */
describe("handleRecordingStatus with the real Zadarma provider — real libsql", () => {
	const SECRET = "itest-zadarma-secret";
	/** Live-shaped: direction prefix + sha1 hex (measured 2026-09-05). */
	const PBX_CALL_ID = "in_20b67427cf29e305a77f09d12a3976e092787adf";

	let zadarmaDeps: RecordingStatusDeps;

	beforeAll(() => {
		zadarmaDeps = {
			...deps,
			telephony: new ZadarmaTelephonyProvider({
				userKey: "itest-user-key",
				secret: SECRET,
				// Placeholder, never the operator's real GSM (mirrors zadarma.test.ts).
				forwardNumber: "+48500100200",
				apiHost: "api.zadarma.test",
			}),
		};
	});

	/**
	 * Webhook recipe: base64 of the HEX hmac-sha1 over the concatenated fields —
	 * the vendor's single `encodeSignature` (`lib/Client.php:112`), which PHP's
	 * hex-by-default `hash_hmac` produces. This helper said RAW until 2026-09-08
	 * and so agreed with a broken verifier; a fixture that mirrors the
	 * implementation cannot detect the implementation being wrong.
	 */
	function sign(params: Record<string, string>): string {
		const signed = `${params.pbx_call_id ?? ""}${params.call_id_with_rec ?? ""}`;
		return Buffer.from(
			createHmac("sha1", SECRET).update(signed).digest("hex"),
		).toString("base64");
	}

	function zadarmaRequest(
		params: Record<string, string>,
		signature = sign(params),
	): Request {
		return new Request("https://your-app.fly.dev/api/telephony/events", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				signature,
			},
			body: new URLSearchParams(params).toString(),
		});
	}

	// The seven ordinary lifecycle events. Zadarma posts every one of them to the
	// same account-level URL on every call, and none is signed with a recipe we
	// know — so each must end as a 200 no-op, not a 403.
	test.each([
		"NOTIFY_START",
		"NOTIFY_INTERNAL",
		"NOTIFY_ANSWER",
		"NOTIFY_END",
		"NOTIFY_OUT_START",
		"NOTIFY_OUT_END",
		"NOTIFY_IVR",
	])("%s is a 200 no-op and writes nothing", async (event) => {
		const res = await handleRecordingStatus(
			// No valid signature exists for these — send a plainly bogus one, which
			// is what an unverifiable event looks like in production.
			zadarmaRequest({ event, pbx_call_id: PBX_CALL_ID }, "not-a-signature"),
			zadarmaDeps,
		);

		expect(res.status).toBe(200);
		expect(await counts()).toEqual({ conversations: 0, jobs: 0 });
	});

	// Control: the relaxation above must not have relaxed the event that WRITES.
	// Without this, "everything is a no-op" would satisfy the tests above.
	test("a correctly signed NOTIFY_RECORD still persists conversation + job", async () => {
		const params = {
			event: "NOTIFY_RECORD",
			pbx_call_id: PBX_CALL_ID,
			call_id_with_rec: "1788618987.62914",
		};

		const res = await handleRecordingStatus(
			zadarmaRequest(params),
			zadarmaDeps,
		);

		expect(res.status).toBe(200);
		expect(await counts()).toEqual({ conversations: 1, jobs: 1 });
		const [row] = (
			await client.execute(
				'SELECT call_sid, recording_sid FROM "memo-call_conversations"',
			)
		).rows;
		// pbx_call_id anchors the idempotency index; call_id_with_rec is the token
		// handed back to `/v1/pbx/record/request`.
		expect(row?.call_sid).toBe(PBX_CALL_ID);
		expect(row?.recording_sid).toBe("1788618987.62914");
	});

	// The write path stays fail-closed. Zadarma's MAC covers no URL, timestamp or
	// nonce, so a forged NOTIFY_RECORD is the one attack this endpoint has — and
	// this is where it is refused.
	test("a NOTIFY_RECORD with a bad signature is 403 and writes nothing", async () => {
		const res = await handleRecordingStatus(
			zadarmaRequest(
				{
					event: "NOTIFY_RECORD",
					pbx_call_id: PBX_CALL_ID,
					call_id_with_rec: "1788618987.62914",
				},
				"forged",
			),
			zadarmaDeps,
		);

		expect(res.status).toBe(403);
		expect(await counts()).toEqual({ conversations: 0, jobs: 0 });
	});

	// The replay control, restated for THIS provider because it is a security
	// control here, not an optimization: Zadarma signs neither URL nor time, so a
	// captured (body, signature) pair is replayable forever. What neutralises it is
	// `conv_user_callsid_uq` + ON CONFLICT DO NOTHING — the same SQL the mock-driven
	// test above covers, asserted here on the provider whose threat model needs it.
	test("a replayed NOTIFY_RECORD creates no second conversation/job", async () => {
		const params = {
			event: "NOTIFY_RECORD",
			pbx_call_id: PBX_CALL_ID,
			call_id_with_rec: "1788618987.62914",
		};

		const first = await handleRecordingStatus(
			zadarmaRequest(params),
			zadarmaDeps,
		);
		const second = await handleRecordingStatus(
			zadarmaRequest(params),
			zadarmaDeps,
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await counts()).toEqual({ conversations: 1, jobs: 1 });
	});
});

describe("handleRecordingStatus — real libsql", () => {
	test("a completed event persists one conversation + one pending job", async () => {
		const res = await handleRecordingStatus(
			completedRequest("CA_REAL_1"),
			deps,
		);
		expect(res.status).toBe(200);

		expect(await counts()).toEqual({ conversations: 1, jobs: 1 });
		const [convRow] = (
			await client.execute(
				'SELECT call_sid, recording_sid, duration_ms FROM "memo-call_conversations"',
			)
		).rows;
		expect(convRow?.call_sid).toBe("CA_REAL_1");
		expect(convRow?.recording_sid).toBe("RE_CA_REAL_1");
		expect(Number(convRow?.duration_ms)).toBe(7000);
		const [jobRow] = (
			await client.execute(
				'SELECT status, attempt_count FROM "memo-call_processing_jobs"',
			)
		).rows;
		expect(jobRow?.status).toBe("pending");
		expect(Number(jobRow?.attempt_count)).toBe(0);
	});

	test("a replayed event with the same CallSid creates NO second conversation/job", async () => {
		const first = await handleRecordingStatus(completedRequest("CA_DUP"), deps);
		const second = await handleRecordingStatus(
			completedRequest("CA_DUP"),
			deps,
		);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		// The real ON CONFLICT DO NOTHING absorbs the duplicate — exactly one of each.
		expect(await counts()).toEqual({ conversations: 1, jobs: 1 });
	});

	test("distinct CallSids each create their own conversation + job", async () => {
		await handleRecordingStatus(completedRequest("CA_A"), deps);
		await handleRecordingStatus(completedRequest("CA_B"), deps);
		expect(await counts()).toEqual({ conversations: 2, jobs: 2 });
	});

	/**
	 * Full-review F1. The tombstone table is stated in `schema.ts` as an
	 * unqualified invariant — "a deleted call is never captured again" — but it was
	 * enforced only in the sweep, i.e. only on the PULL path. This drives the PUSH
	 * path.
	 *
	 * The setup is not hypothetical: deleting the conversation is exactly what
	 * removes the row `conv_user_callsid_uq` was absorbing, so after a delete the
	 * replay defense named in `backfill.ts`'s header is gone and Zadarma's
	 * signature — which covers no URL, no timestamp and no nonce — stays valid
	 * forever. Without the guard inside `backfillConversation` this test creates a
	 * conversation and a job, and the user's deleted note comes back with its audio
	 * re-sent to Deepgram and Bedrock.
	 */
	test("a tombstoned CallSid is NOT re-created by a replayed webhook", async () => {
		await client.execute({
			sql: 'INSERT INTO "memo-call_reconcile_tombstones" (id, user_id, call_sid) VALUES (?, ?, ?)',
			args: ["tomb-1", "me", "CA_BURIED"],
		});

		const res = await handleRecordingStatus(
			completedRequest("CA_BURIED"),
			deps,
		);

		// Still a 200: the event was well-formed and authorized, we simply refuse to
		// act on it. A 4xx here would make the vendor retry something we will never
		// accept.
		expect(res.status).toBe(200);
		expect(await counts()).toEqual({ conversations: 0, jobs: 0 });
	});

	test("a tombstone for a DIFFERENT user does not block this user's capture", async () => {
		await client.execute({
			sql: 'INSERT INTO "memo-call_users" (id) VALUES (?) ON CONFLICT DO NOTHING',
			args: ["someone-else"],
		});
		await client.execute({
			sql: 'INSERT INTO "memo-call_reconcile_tombstones" (id, user_id, call_sid) VALUES (?, ?, ?)',
			args: ["tomb-2", "someone-else", "CA_OTHER_USER"],
		});

		await handleRecordingStatus(completedRequest("CA_OTHER_USER"), deps);

		// The lookup is (user_id, call_sid), not call_sid alone — the same
		// multi-user-ready invariant every other query in this repo carries.
		expect(await counts()).toEqual({ conversations: 1, jobs: 1 });
	});
});
