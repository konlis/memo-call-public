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
import { conversations, tags, users } from "~/server/db/schema";
import { reconcileTags, type TagPolicy } from "~/server/tags/reconcile";

// Real-libsql integration test (per CLAUDE.md "Lessons"): the reconciler IS SQL — a delete
// whose predicate list changes by policy, plus an insert loop inside a transaction.
// A stub db would assert nothing about the thing that can actually break. Until now
// both policies were only reachable through a whole job worker; this suite drives
// them directly.
const DB_PATH = makeIntegrationDbPath("reconcile");
const DB_URL = `file:${DB_PATH}`;

function cleanupFiles() {
	cleanupIntegrationDb(DB_PATH);
}

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

const CONV = "conv-1";

beforeAll(async () => {
	cleanupFiles();
	client = createClient({ url: DB_URL });
	await client.execute("PRAGMA foreign_keys = ON;");
	await migrate(drizzle(client), { migrationsFolder: "drizzle" });
	db = drizzle(client, { schema });
	// `me` is seeded by drizzle/0000; `other` exists only to prove the userId scoping.
	await db.insert(users).values({ id: "other" }).onConflictDoNothing();
});

afterAll(() => {
	client?.close();
	cleanupFiles();
});

beforeEach(async () => {
	await client.execute('DELETE FROM "memo-call_tags"');
	await client.execute('DELETE FROM "memo-call_conversations"');
	await db.insert(conversations).values({
		id: CONV,
		userId: "me",
		callSid: "CA_1",
	});
});

async function seedTag(opts: {
	name: string;
	isUserEdited: boolean;
	userId?: string;
}): Promise<void> {
	await db.insert(tags).values({
		id: `tag-${opts.userId ?? "me"}-${opts.name}`,
		userId: opts.userId ?? "me",
		conversationId: CONV,
		name: opts.name,
		isUserEdited: opts.isUserEdited,
	});
}

/** Every tag row on the conversation, across users — ordered for stable assertions. */
async function tagRows() {
	const r = await client.execute({
		sql: 'SELECT user_id, name, is_user_edited FROM "memo-call_tags" WHERE conversation_id = ? ORDER BY user_id, name',
		args: [CONV],
	});
	return r.rows.map((row) => ({
		userId: String(row.user_id),
		name: String(row.name),
		isUserEdited: Number(row.is_user_edited) === 1,
	}));
}

/** Drive the reconciler the way both workers do — inside a transaction. */
function reconcile(
	policy: TagPolicy,
	candidates: string[],
	userId = "me",
): Promise<string[]> {
	return db.transaction((tx) =>
		reconcileTags(tx, {
			userId,
			conversationId: CONV,
			candidates,
			policy,
		}),
	);
}

describe("reconcileTags — replace-all policy", () => {
	test("clears EVERY prior tag, including user-edited ones", async () => {
		await seedTag({ name: "recznie-dodany", isUserEdited: true });
		await seedTag({ name: "stary-auto", isUserEdited: false });

		const inserted = await reconcile("replace-all", ["Nowy Tag", "drugi"]);

		expect(inserted).toEqual(["nowy-tag", "drugi"]);
		expect(await tagRows()).toEqual([
			{ userId: "me", name: "drugi", isUserEdited: false },
			{ userId: "me", name: "nowy-tag", isUserEdited: false },
		]);
	});

	test("leaves ANOTHER user's tags on the same conversation untouched", async () => {
		// The behavioral delta of this extraction: worker.ts's delete had no `userId`
		// predicate (`delete(tags).where(eq(conversationId, …))`). Harmless today —
		// `userId` is the constant 'me' — but the reconciler is the multi-user-shaped
		// version, and this is the assertion that says so.
		await seedTag({ name: "cudzy", isUserEdited: false, userId: "other" });
		await seedTag({ name: "moj", isUserEdited: false });

		await reconcile("replace-all", ["swiezy"]);

		expect(await tagRows()).toEqual([
			{ userId: "me", name: "swiezy", isUserEdited: false },
			{ userId: "other", name: "cudzy", isUserEdited: false },
		]);
	});
});

describe("reconcileTags — merge policy", () => {
	test("preserves user-edited tags and regenerates only the auto ones", async () => {
		await seedTag({ name: "recznie-dodany", isUserEdited: true });
		await seedTag({ name: "stary-auto", isUserEdited: false });

		const inserted = await reconcile("merge", ["nowy-auto"]);

		expect(inserted).toEqual(["nowy-auto"]);
		expect(await tagRows()).toEqual([
			{ userId: "me", name: "nowy-auto", isUserEdited: false },
			{ userId: "me", name: "recznie-dodany", isUserEdited: true },
		]);
	});

	test("skips a candidate whose canonical name collides with a survivor", async () => {
		await seedTag({ name: "wspolny", isUserEdited: true });

		const inserted = await reconcile("merge", ["Wspólny", "inny"]);

		// `Wspólny` normalizes onto the survivor → skipped, NOT inserted as a second
		// row and NOT reported as inserted.
		expect(inserted).toEqual(["inny"]);
		expect(await tagRows()).toEqual([
			{ userId: "me", name: "inny", isUserEdited: false },
			{ userId: "me", name: "wspolny", isUserEdited: true },
		]);
	});

	test("a NON-canonical survivor misses the collision (pins the canonical-storage dependency, not desired behavior)", async () => {
		// The unit-level twin of reanalyze.test.ts's characterization. The collision
		// skip compares canonical candidates against RAW survivor names, so it holds
		// only while user-edited tags are stored canonically (the tags router
		// normalizes on write, S-05). Seeded non-canonically on purpose: today the
		// collision is missed and a near-duplicate auto row lands beside the user's
		// tag. Carried over verbatim by the extraction — if a future change makes the
		// comparison canonical-to-canonical, this test goes red and the diff is the
		// deliberate decision.
		await seedTag({ name: "Klient Nowy", isUserEdited: true });

		const inserted = await reconcile("merge", ["Klient Nowy"]);

		expect(inserted).toEqual(["klient-nowy"]);
		expect(await tagRows()).toEqual([
			{ userId: "me", name: "Klient Nowy", isUserEdited: true },
			{ userId: "me", name: "klient-nowy", isUserEdited: false },
		]);
	});

	test("does not touch another user's rows when choosing survivors or deleting", async () => {
		await seedTag({ name: "cudzy-auto", isUserEdited: false, userId: "other" });
		await seedTag({ name: "moj-auto", isUserEdited: false });

		await reconcile("merge", ["swiezy"]);

		expect(await tagRows()).toEqual([
			{ userId: "me", name: "swiezy", isUserEdited: false },
			{ userId: "other", name: "cudzy-auto", isUserEdited: false },
		]);
	});
});

describe("reconcileTags — normalization applies to both policies", () => {
	// Table-driven: the write-time canonical-form rule (S-05 / FR-017) is a property
	// of the reconciler, not of either policy.
	const policies: TagPolicy[] = ["replace-all", "merge"];

	for (const policy of policies) {
		test(`${policy}: de-dupes candidates that normalize to the same name`, async () => {
			const inserted = await reconcile(policy, [
				"Klient Nowy",
				"klient  nowy",
				"KLIENT_NOWY",
			]);

			expect(inserted).toEqual(["klient-nowy"]);
			expect(await tagRows()).toEqual([
				{ userId: "me", name: "klient-nowy", isUserEdited: false },
			]);
		});

		test(`${policy}: drops candidates that normalize to nothing`, async () => {
			const inserted = await reconcile(policy, ["!!!", "   ", "ok"]);

			expect(inserted).toEqual(["ok"]);
			expect(await tagRows()).toEqual([
				{ userId: "me", name: "ok", isUserEdited: false },
			]);
		});
	}
});
