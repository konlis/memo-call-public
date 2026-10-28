import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted mock surfaces for sibling modules. `vi.hoisted` lets `vi.mock`
// factories below reference these stubs from the same module scope without
// TDZ trouble. We no longer mock `~/server/db` — credentialsAuthorize now
// accepts opts.db (F-02 DI pattern), so tests pass a structural stub directly.
const { mocks } = vi.hoisted(() => ({
	mocks: {
		verifyPassword: vi.fn(),
		checkLockout: vi.fn(),
		recordFailedLogin: vi.fn(),
		recordSuccessfulLogin: vi.fn(),
	},
}));

vi.mock("~/server/auth/password", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("~/server/auth/password")>();
	return { ...actual, verifyPassword: mocks.verifyPassword };
});

vi.mock("~/server/auth/lockout", async (importOriginal) => {
	const actual = await importOriginal<typeof import("~/server/auth/lockout")>();
	return {
		...actual,
		checkLockout: mocks.checkLockout,
		recordFailedLogin: mocks.recordFailedLogin,
		recordSuccessfulLogin: mocks.recordSuccessfulLogin,
	};
});

// Imports come after mocks. The throttle module uses its real implementation
// (it's pure in-process state; reset between tests via the test-only seam).
import { credentialsAuthorize } from "./credentials-authorize";
import type { LockoutDb } from "./lockout";
import { _resetThrottleStateForTests, recordFailure } from "./throttle";

function makeRequest(ip = "1.2.3.4") {
	return new Request("http://test.local", {
		headers: { "fly-client-ip": ip },
	});
}

type StubRow =
	| {
			passwordHash: string | null;
			failedAttemptsCount: number;
	  }
	| undefined;

function makeStubDb(row: StubRow): {
	db: LockoutDb;
	findFirst: ReturnType<typeof vi.fn>;
} {
	const findFirst = vi.fn().mockResolvedValue(row);
	const db = {
		query: { authConfig: { findFirst } },
		// update/insert kept inert — lockout module is mocked, so these are
		// never called from this test path; satisfy the LockoutDb type only.
		update: vi.fn(),
		insert: vi.fn(),
	} as unknown as LockoutDb;
	return { db, findFirst };
}

beforeEach(() => {
	mocks.verifyPassword.mockReset();
	mocks.checkLockout.mockReset();
	mocks.recordFailedLogin.mockReset().mockResolvedValue(undefined);
	mocks.recordSuccessfulLogin.mockReset().mockResolvedValue(undefined);
	mocks.checkLockout.mockResolvedValue({ locked: false });
	_resetThrottleStateForTests();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("credentialsAuthorize", () => {
	test("happy path returns {id: 'me'}", async () => {
		const { db } = makeStubDb({
			passwordHash: "hash",
			failedAttemptsCount: 0,
		});
		mocks.verifyPassword.mockResolvedValue(true);

		const result = await credentialsAuthorize(
			{ password: "test-12-char-pwd" },
			makeRequest(),
			{ db },
		);

		expect(result).toEqual({ id: "me" });
		expect(mocks.recordSuccessfulLogin).toHaveBeenCalledTimes(1);
		expect(mocks.recordFailedLogin).not.toHaveBeenCalled();
	});

	test("wrong password returns null + records failure", async () => {
		const { db } = makeStubDb({
			passwordHash: "hash",
			failedAttemptsCount: 4,
		});
		mocks.verifyPassword.mockResolvedValue(false);

		const result = await credentialsAuthorize(
			{ password: "wrong-pwd" },
			makeRequest(),
			{ db },
		);

		expect(result).toBeNull();
		expect(mocks.recordFailedLogin).toHaveBeenCalledTimes(1);
		expect(mocks.recordSuccessfulLogin).not.toHaveBeenCalled();
	});

	test("no config row returns null without DB write", async () => {
		const { db } = makeStubDb(undefined);

		const result = await credentialsAuthorize(
			{ password: "test-12-char-pwd" },
			makeRequest(),
			{ db },
		);

		expect(result).toBeNull();
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
		expect(mocks.recordFailedLogin).not.toHaveBeenCalled();
	});

	test("throttled IP returns null without DB lookup", async () => {
		// Trip the in-process throttle: 30 failures from this IP first.
		for (let i = 0; i < 30; i++) recordFailure("1.2.3.4");
		const { db, findFirst } = makeStubDb(undefined);

		const result = await credentialsAuthorize(
			{ password: "test-12-char-pwd" },
			makeRequest("1.2.3.4"),
			{ db },
		);

		expect(result).toBeNull();
		expect(mocks.checkLockout).not.toHaveBeenCalled();
		expect(findFirst).not.toHaveBeenCalled();
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
	});

	test("locked account returns null without bcrypt (direct verifyPassword spy)", async () => {
		mocks.checkLockout.mockResolvedValue({
			locked: true,
			retryAfterMs: 25 * 60 * 1000,
		});
		const { db, findFirst } = makeStubDb(undefined);

		const result = await credentialsAuthorize(
			{ password: "test-12-char-pwd" },
			makeRequest(),
			{ db },
		);

		expect(result).toBeNull();
		// F5 fix: direct spy assertion — locks the "lockout short-circuits before
		// bcrypt" semantic against silent regression.
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
		expect(findFirst).not.toHaveBeenCalled();
	});

	test("malformed credentials (missing password) returns null", async () => {
		const { db, findFirst } = makeStubDb(undefined);

		const result = await credentialsAuthorize({}, makeRequest(), { db });

		expect(result).toBeNull();
		expect(mocks.checkLockout).not.toHaveBeenCalled();
		expect(findFirst).not.toHaveBeenCalled();
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
	});
});
