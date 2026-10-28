/**
 * Shared vocabulary for the conversation-list filter — importable by BOTH the
 * `conversations` router (server predicate) and the list view (client control),
 * mirroring how `projects/schema.ts` and `tags/normalize.ts` are shared. Zero
 * server-only imports, so the client pulls it without dragging server deps in.
 */

/**
 * Sentinel `filter.projectId` value meaning "conversations with NO project".
 *
 * It is a magic string rather than `projectId: string | null` on purpose.
 * react-query hashes the whole procedure input into its cache key, so a `null`
 * field is a DIFFERENT key from an omitted one — modelling "unassigned" as
 * `null` would break the one rule that keeps the default (no-filter) client key
 * byte-identical to the server prefetch's: build `filterObj` only from ACTIVE
 * constraints and omit it entirely when empty (see `_lib/list-config.ts`).
 * Keeping both variants inside `string` means the client never has to special-
 * case a filter that is active but "empty".
 *
 * Collision safety comes from the app's own write path, NOT from an enforced
 * invariant: `projects.create` is the only producer of project ids and it uses
 * `crypto.randomUUID()`, which can never contain an underscore. The column has
 * no CHECK constraint, so a row inserted by hand (test fixtures already use
 * `p-test`-shaped ids) COULD carry this literal id — and it would then be
 * shadowed by the sentinel branch, unreachable by the filter.
 */
export const UNASSIGNED_PROJECT = "__none__";

/**
 * Shortest search phrase (after trim) the list filter accepts. Below this the
 * router rejects (`z.string().trim().min(SEARCH_MIN_CHARS)`) and the client
 * does not send — a one-character prefix query matches practically every
 * conversation, so it would only ever produce a flash of "everything" before
 * the real phrase arrives. Shared so the two sides cannot disagree on where
 * the threshold is.
 */
export const SEARCH_MIN_CHARS = 2;

/**
 * Longest search phrase the list filter accepts. Every letter/digit token
 * becomes one AND-ed FTS5 phrase evaluated against the index, so an unbounded
 * phrase is a cheap CPU sink on the single Machine — a pasted paragraph is
 * not a search. 200 chars is far past any phrase a person types to find a
 * conversation. Router rejects above it; the input carries it as `maxLength`.
 */
export const SEARCH_MAX_CHARS = 200;
