import { safeErrorMessage } from "~/server/_lib/redact";

export type AuthEvent =
	| "login_success"
	| "login_failed_wrong_password"
	| "login_failed_no_config"
	| "login_failed_throttled"
	| "login_failed_locked"
	| "login_failed_db_write_error"
	| "proxy_db_error"
	| "setup_password_set";

export type AuthEventFields = {
	ip?: string;
	userId?: string;
	attemptCount?: number;
	retryAfterMs?: number;
	error?: string;
};

// Structured stderr audit emission. One JSON line per call, visible in
// `fly logs` via `grep '"event":"<name>"' ...`. Stderr (NOT stdout) so the
// audit channel is distinguishable from request-timing logs.
export function logAuthEvent(event: AuthEvent, fields: AuthEventFields): void {
	// Defence in depth (FR-025): `error` arrives through `safeErrorMessage`, but
	// a raw `DrizzleQueryError` text would print the failed statement's bound
	// values, so the field is masked here too. Spread-then-override keeps it in
	// its original key position.
	console.error(
		JSON.stringify({
			event,
			ts: Date.now(),
			...fields,
			...(fields.error === undefined
				? {}
				: { error: safeErrorMessage(fields.error) }),
		}),
	);
}
