/**
 * Recognize a SQLite UNIQUE-constraint violation — one pure, testable rule.
 *
 * WHY IT IS A SEPARATE FUNCTION. `contacts.create` checks for a duplicate number
 * with a SELECT and then INSERTs; between those two statements a concurrent
 * writer could take the number, so the INSERT is wrapped in a `try`. A bare
 * `catch { throw CONFLICT }` would turn EVERY write failure — a foreign-key
 * violation, a NOT NULL violation, a dropped connection — into "this number
 * already has a contact": a silent failure wearing a confident, wrong
 * diagnosis. So the catch needs a predicate, and a predicate inside a catch
 * block is untestable. Hoisting it here makes it feedable with a REAL libsql
 * error object captured from a real duplicate INSERT.
 *
 * WHY TWO MATCHES. libsql surfaces the violation in different shapes depending
 * on the path (client vs. drizzle wrapper, and whether the cause is preserved):
 * sometimes as a `code` of `SQLITE_CONSTRAINT_UNIQUE`, sometimes only as the
 * message text `UNIQUE constraint failed: …`. Matching either is deliberate;
 * matching only one leaves the catch silently dead on the other path.
 *
 * Anything this returns `false` for must be rethrown untouched by the caller.
 */
export function isUniqueViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;

	// libsql attaches a string `code`; nested `cause` covers wrappers that keep
	// the original error rather than re-throwing it flat.
	const code = (err as { code?: unknown }).code;
	if (typeof code === "string" && code.includes("SQLITE_CONSTRAINT_UNIQUE")) {
		return true;
	}

	const message = (err as { message?: unknown }).message;
	if (
		typeof message === "string" &&
		message.includes("UNIQUE constraint failed")
	) {
		return true;
	}

	const cause = (err as { cause?: unknown }).cause;
	return cause !== undefined && cause !== err
		? isUniqueViolation(cause)
		: false;
}
