/**
 * The tag vocabulary handed to `analyze()` (`tag-vocabulary-control`, phase 5).
 *
 * ONE module for both pipelines. `worker.ts` (audio-first) and `reanalyze.ts`
 * (transcript-sourced) each call `loadPromptVocabulary` one line before
 * `analyze()`; skipping the re-analyze path would mean every transcript edit
 * silently undoes the consolidation the first run achieved. The composition
 * rule therefore lives here rather than at either call site — the same
 * one-copy-of-the-rule argument that puts the ranking query in
 * `src/server/tags/rank.ts` and the tag policies in `src/server/tags/reconcile.ts`.
 */

import { safeErrorMessage } from "~/server/_lib/redact";
import { logJobEvent } from "~/server/jobs/audit";
import { MAX_TAG_LENGTH } from "~/server/tags/normalize";
import {
	listTagsWithCounts,
	type RankedTag,
	type TagReader,
} from "~/server/tags/rank";

/**
 * A tag EARNS its place in the dictionary at two uses — or is PUT there by the
 * user, at any count (see `selectPromptVocabulary`).
 *
 * Measured on prod 2026-09-11 (plan, phase 3): 184 distinct names over 44
 * conversations, **164 of them used exactly once**. A plain "top 40 by count"
 * would have padded the list with 20 alphabetically-chosen one-offs (`crm`,
 * `demo`, …) and presented that noise to the model as "the existing
 * vocabulary" — teaching it that the namespace is arbitrary is worse than
 * giving it no namespace. A name used once has not yet proven it names
 * anything… unless a person said it does.
 */
export const VOCABULARY_MIN_USES = 2;

/**
 * Upper bound on the names sent. At the measured scale the ≥2 filter leaves 20
 * names (~100–150 tokens), so this bound is dormant today; it exists so the
 * per-call cost stays bounded as the cloud grows, and so the list stays short
 * enough that the model reads it as a concrete choice rather than background.
 */
export const VOCABULARY_MAX_NAMES = 40;

/**
 * Names never offered to the model, however often they are used.
 *
 * NOT a quality filter and NOT "meta tags" — the line is whether a name
 * DISTINGUISHES anything. `krotka-rozmowa` fits any short conversation about
 * any subject, so offering it is offering a free pass: when the model is asked
 * to prefer existing names, the emptiest ones match everything and win.
 * Measured on prod (2026-09-15, criterion 5.9): a conversation about buying and
 * importing a car came back `konsultacja` + `krotka-rozmowa` + `sprzedaz`, with
 * no new name coined.
 *
 * ⚠️ `poczta-glosowa` is deliberately NOT here, and the distinction is the whole
 * point of the list. It describes the recording's form, so it looks like the
 * same category — but for a voicemail that IS the subject, and the
 * voicemail-processed-not-gated decision means those recordings get described
 * like any other. Removing it would blind the model to the settled name and
 * bring its spelling variants straight back, which is the drift this phase
 * exists to stop. "Describes the form" is the wrong test; "could be true of any
 * conversation" is the right one.
 *
 * Excluding a name here does NOT hide it from the tag cloud, from search, or
 * from any conversation already carrying it — it only stops the prompt
 * proposing it. Keep the list short; every entry is a product judgement about
 * one Polish word, and a long list is a sign the prompt wording is doing too
 * little work.
 */
export const VOCABULARY_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
	"krotka-rozmowa",
]);

/**
 * The pure slice: ranked tags → the names to put in the prompt.
 *
 * Admission is `(count >= VOCABULARY_MIN_USES || isUserEdited)` minus the
 * `VOCABULARY_EXCLUDED_NAMES` carve-out — **the same
 * predicate the tag cloud applies** (`_lib/tag-cloud.ts`), and it must stay the
 * same one. A count-only gate reads as the stricter, more principled rule and
 * is in fact the harmful one: it excludes precisely the user's strongest
 * signal. `tags.add`, a per-conversation `rename`, and a `mergeGlobal` whose
 * two variants sat on ONE conversation all leave a single row flagged
 * `is_user_edited` — so the one name a person deliberately curated would be the
 * one name the model is never shown, in a dictionary whose entire job is to
 * stop the model re-coining variants. The merge path already accepted this
 * trade for the cloud in so many words ("a curated tag is worth showing",
 * `routers/tags.ts`); the dictionary now accepts it too (impl-review phase 5, F1).
 *
 * The cap is applied to the SELECTION, then the result is emitted in ranking
 * order. Two consequences, both deliberate:
 *
 *  - When the cap bites, it drops the lowest-ranked EARNED names, never a
 *    curated one — curated names are reserved first. `listTagsWithCounts`
 *    sorts by count, so a curated singleton sits at the tail and would
 *    otherwise be the first thing cut, which is backwards.
 *  - Curated names are NOT hoisted to the front. They appear in their natural
 *    rank position, so the prompt's own claim ("posortowane od najczęstszych")
 *    stays true.
 *
 * Relies on `listTagsWithCounts` ordering by count desc, name asc — a total
 * order, so a given table state yields ONE list and the prompt is reproducible.
 * Exported separately from the loader so the rule is unit-testable without a DB.
 */
export function selectPromptVocabulary(
	ranked: ReadonlyArray<RankedTag>,
): string[] {
	const admitted = new Set<string>();

	// `normalizeTag` already refuses to STORE a name longer than this, so in a
	// healthy table the guard never fires. It is here anyway because the 40-name
	// cap bounds the COUNT, not the bytes: without a length bound the prompt
	// contribution is `40 × unbounded`, and making the prompt's size depend on
	// another module staying correct is the wrong coupling (impl-review F2).
	const admissible = (tag: RankedTag) =>
		tag.name.length <= MAX_TAG_LENGTH &&
		!VOCABULARY_EXCLUDED_NAMES.has(tag.name);

	// Pass 1 — the user's own decisions, reserved against the cap.
	for (const tag of ranked) {
		if (admitted.size === VOCABULARY_MAX_NAMES) break;
		if (tag.isUserEdited && admissible(tag)) admitted.add(tag.name);
	}
	// Pass 2 — names that earned their place by being used, best-ranked first.
	for (const tag of ranked) {
		if (admitted.size === VOCABULARY_MAX_NAMES) break;
		if (tag.count >= VOCABULARY_MIN_USES && admissible(tag))
			admitted.add(tag.name);
	}

	// Emit in ranking order, not admission order.
	return ranked.filter((tag) => admitted.has(tag.name)).map((tag) => tag.name);
}

/**
 * Read the vocabulary for `userId`, DEGRADING TO AN EMPTY LIST on any failure.
 *
 * The degradation is the contract, not defensive habit: an analysis without a
 * vocabulary is worse (it may coin a redundant tag), but a job that throws here
 * is a LOST NOTE — the pipeline's one unacceptable outcome (the same trade the
 * voicemail-processed-not-gated decision makes, the same way). The failure is
 * therefore loud in `fly logs` and invisible to the user.
 *
 * Called BEFORE the closing transaction in both workers, never inside it: the
 * done-txn holds SQLite's single writer lock and must stay narrow.
 */
export async function loadPromptVocabulary(
	db: TagReader,
	opts: { userId: string; jobId: string; conversationId: string },
): Promise<string[]> {
	try {
		const ranked = await listTagsWithCounts(db, { userId: opts.userId });
		return selectPromptVocabulary(ranked);
	} catch (err) {
		logJobEvent({
			event: "job.vocabulary_unavailable",
			jobId: opts.jobId,
			conversationId: opts.conversationId,
			error: safeErrorMessage(err),
		});
		return [];
	}
}
