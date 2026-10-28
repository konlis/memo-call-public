/**
 * Shared tag normalization — the canonical-form rule for S-05 (FR-017).
 *
 * Importable by BOTH the server (worker write, `tags` router validation) and the
 * client (filter chips, edit-input preview), mirroring how `projects/schema.ts`
 * and `telephony/phone.ts` share a pure rule across the boundary. Zero
 * server-only imports so the client can pull it without dragging server deps in.
 *
 * `normalizeTag` NEVER throws — it returns the canonical string, or `null` when
 * the input reduces to nothing (so a tag that is only punctuation/diacritics-
 * that-strip-out is dropped, never stored as an empty row) or exceeds
 * `MAX_TAG_LENGTH`.
 */

/**
 * Longest canonical tag name that may be STORED (impl-review phase 5, F2).
 *
 * The bound belongs here, not in `analysisSchema`, and the difference matters:
 * rejecting a long `candidateTags` element at the schema would make the LLM's
 * whole response fail `safeParse` → a non-retryable `invalid_response` → a
 * dead-lettered analysis, i.e. a lost note traded for a cosmetic limit.
 * Rejecting it HERE reuses the path that already exists for a name reducing to
 * nothing: `normalizeTags` drops it and the rest of the analysis lands, while
 * the `tags` router surfaces the same explicit `BAD_REQUEST` it already raises.
 *
 * Because every write path canonicalizes through this function, the bound is an
 * invariant of the TABLE — which is what makes the `analyze()` prompt's size
 * bounded in bytes and not merely in number of names (the 40-name cap alone
 * bounds neither). 64 is comfortably above any real tag
 * (`integracja-systemow-crm` is 23) and well below anything that distorts a
 * prompt.
 */
export const MAX_TAG_LENGTH = 64;

/**
 * Polish diacritics → ASCII. Both cases are listed for robustness even though
 * `toLowerCase()` runs first, so the uppercase keys are effectively dead — kept
 * to honor the documented contract and guard against any locale edge.
 */
const POLISH_DIACRITICS: Record<string, string> = {
	ą: "a",
	ć: "c",
	ę: "e",
	ł: "l",
	ń: "n",
	ó: "o",
	ś: "s",
	ż: "z",
	ź: "z",
	Ą: "a",
	Ć: "c",
	Ę: "e",
	Ł: "l",
	Ń: "n",
	Ó: "o",
	Ś: "s",
	Ż: "z",
	Ź: "z",
};

/**
 * Polish diacritics → ASCII, case preserved otherwise. The ONE source of the
 * transliteration rule: `normalizeTag` uses it for tag names, and the
 * conversation search (`~/server/conversations/search`) uses it on the query
 * phrase so that the TS side folds exactly what the FTS5 trigger folds at
 * index time (`drizzle/0005_conversations_fts.sql`). Two copies of this table
 * would be two places for `ł` to go missing from.
 */
export function foldPolishDiacritics(s: string): string {
	return s.replace(
		/[ąćęłńóśżźĄĆĘŁŃÓŚŻŹ]/g,
		(ch) => POLISH_DIACRITICS[ch] ?? ch,
	);
}

/**
 * Turn a raw LLM/user tag into canonical form:
 *   lowercase → trim → transliterate Polish diacritics to ASCII → runs of
 *   whitespace/underscore become a single `-` → strip anything outside
 *   `[a-z0-9-]` → collapse repeated `-` → trim leading/trailing `-`.
 *
 * Order is load-bearing: whitespace/underscore are turned into dashes BEFORE the
 * invalid-char strip, otherwise word separators would be deleted (joining words)
 * instead of becoming dashes. Returns `null` if the result is empty.
 */
export function normalizeTag(raw: string): string | null {
	const result = foldPolishDiacritics(raw.toLowerCase().trim())
		.replace(/[\s_]+/g, "-") // whitespace/underscore runs → single dash
		.replace(/[^a-z0-9-]/g, "") // strip anything not canonical
		.replace(/-+/g, "-") // collapse repeated dashes
		.replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
	if (result.length === 0 || result.length > MAX_TAG_LENGTH) return null;
	return result;
}

/**
 * Normalize a raw list, drop the nulls, and de-dupe — preserving the
 * first-occurrence order of the surviving canonical names.
 */
export function normalizeTags(raw: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of raw) {
		const name = normalizeTag(r);
		if (name !== null && !seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}
