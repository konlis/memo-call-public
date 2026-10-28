import { describe, expect, test } from "vitest";

import { hashPassword, verifyPassword } from "./password";
// Import schema from the no-deps source (password-rules), NOT via password.ts's
// re-export — keeps the test honest about the no-bcryptjs-on-client guarantee.
import { PASSWORD_VALIDATION_SCHEMA } from "./password-rules";

describe("password", () => {
	test("verifyPassword returns true for matching password", async () => {
		const hash = await hashPassword("test-12-char-pwd");
		expect(await verifyPassword("test-12-char-pwd", hash)).toBe(true);
	});

	test("verifyPassword returns false for wrong password", async () => {
		const hash = await hashPassword("test-12-char-pwd");
		expect(await verifyPassword("other-12-char-pwd", hash)).toBe(false);
	});

	test("PASSWORD_VALIDATION_SCHEMA accepts >=12 chars", () => {
		expect(() =>
			PASSWORD_VALIDATION_SCHEMA.parse("xxxxxxxxxxxx"),
		).not.toThrow();
	});

	test("PASSWORD_VALIDATION_SCHEMA accepts >=4 words", () => {
		expect(() =>
			PASSWORD_VALIDATION_SCHEMA.parse("correct horse battery staple"),
		).not.toThrow();
	});

	test("PASSWORD_VALIDATION_SCHEMA rejects short single word", () => {
		expect(() => PASSWORD_VALIDATION_SCHEMA.parse("short")).toThrow();
	});
});
