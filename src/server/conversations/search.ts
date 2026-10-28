/**
 * Query-side half of the full-text search (tag-vocabulary-control, phase 2).
 *
 * The index-side half is the FTS5 virtual table + triggers in
 * `drizzle/0005_conversations_fts.sql`. This module turns the user's raw phrase
 * into the string handed to `MATCH`, and it has exactly two jobs:
 *
 * 1. **Symmetry with the trigger.** The trigger folds `ł`/`Ł` → `l` before
 *    indexing (FTS5's `remove_diacritics 2` handles every other Polish letter
 *    but not `ł`, which has no canonical decomposition). The phrase must be
 *    folded the SAME way or every word containing `ł` is a silent zero —
 *    measured during planning: `MATCH 'platnosc*'` → 1 row, `MATCH 'płatność'`
 *    → 0 rows over the same index. We fold ALL Polish diacritics via the shared
 *    `foldPolishDiacritics` (a superset of the trigger's fold): the tokenizer
 *    would fold the rest at query time anyway, so the result is identical and
 *    there is one transliteration table in the repo, not two.
 *
 * 2. **Never let the user reach the FTS5 query parser.** `MATCH` has its own
 *    grammar (`AND`/`OR`/`NOT`/`NEAR`, `*`, `^`, `-`, `:` column filters, `"`).
 *    An unbalanced quote or a bare `*` is a SQL error → a 500 from the list
 *    query. Rather than escaping a list of special characters (lists rot), the
 *    phrase is split into letter/digit tokens and EACH token is wrapped in
 *    double quotes — inside a quoted FTS5 string every character is a literal
 *    (measured: `"-"`, `"*"`, `"or"` all return 0 rows and no error). Tokens
 *    are implicitly AND-ed. The last token gets a `*` prefix operator when it
 *    is ≥ 3 chars so "faktur" finds "faktury"/"fakturowanie" (Polish inflection
 *    without a stemmer); shorter prefixes match practically everything.
 */

import { foldPolishDiacritics } from "~/server/tags/normalize";

/** Minimum length of the last token for it to become a prefix query. */
const PREFIX_MIN_CHARS = 3;

/**
 * Build the FTS5 `MATCH` expression for a raw user phrase.
 *
 * Returns `null` when the phrase contains no letter/digit token at all (e.g.
 * `"--"` or `"**"`) — the caller decides what a token-less search means (the
 * router treats it as "matches nothing", never as "no filter": the user asked
 * to narrow, and showing everything would be the misleading answer).
 */
export function buildFtsMatchQuery(raw: string): string | null {
	const tokens = foldPolishDiacritics(raw)
		.toLowerCase()
		// Unicode-aware split: anything that is not a letter or a number is a
		// separator, which is also what FTS5's `unicode61` tokenizer does, so a
		// token here is always ≥ 1 index token there (never an empty phrase).
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);
	if (tokens.length === 0) return null;

	const quoted = tokens.map((t) => `"${t}"`);
	const last = tokens[tokens.length - 1] as string;
	if (last.length >= PREFIX_MIN_CHARS) {
		quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}*`;
	}
	return quoted.join(" ");
}
