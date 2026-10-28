import bcrypt from "bcryptjs";

// bcryptjs at WORK_FACTOR=12 takes ~150-300 ms per compare on Fly shared-CPU
// 256MB. Single-user login is the only place this fires; acceptable cost.
const WORK_FACTOR = 12;

export async function hashPassword(plain: string): Promise<string> {
	return bcrypt.hash(plain, WORK_FACTOR);
}

export async function verifyPassword(
	plain: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(plain, hash);
}

export { PASSWORD_VALIDATION_SCHEMA } from "./password-rules";
