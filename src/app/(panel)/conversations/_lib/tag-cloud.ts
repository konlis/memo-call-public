/**
 * The tag cloud's presentation rule (`tag-vocabulary-control`, phase 3) as a
 * pure function over the ranked list `tags.listWithCounts` returns.
 *
 * The threshold and the trim live HERE, on the client, not in the query: the
 * same ranked list feeds global merge (phase 4) and the prompt vocabulary
 * (phase 5), both of which need the whole tail. Kept out of the component so
 * the rule is unit-testable without a DOM (`tag-cloud.test.ts`), the same way
 * `list-config.ts` keeps the page size out of both render paths.
 */

import { foldPolishDiacritics } from "~/server/tags/normalize";

/** Minimum usage count for a tag to be shown in the collapsed cloud. */
export const TAG_MIN_COUNT = 2;

/** Chip cap for the collapsed cloud — one click reveals the rest. */
export const TAG_CLOUD_LIMIT = 15;

export type CloudTag = {
	name: string;
	count: number;
	isUserEdited: boolean;
};

export type TagCloudInput = {
	/** The ranked list, already `count desc, name asc` from the server. */
	tags: readonly CloudTag[];
	/** Names currently narrowing the list — they must never disappear. */
	selected: readonly string[];
	/** True after "pokaż wszystkie": lifts BOTH the threshold and the cap. */
	showAll: boolean;
	/** Client-side substring filter over chip names (case-insensitive). */
	query: string;
};

export type TagCloud = {
	/** Chips to render, in ranking order, selected-but-filtered-out appended. */
	visible: CloudTag[];
	/**
	 * How many tags the collapsed cloud is holding back (threshold + cap), for
	 * the "pokaż wszystkie (N)" affordance. 0 when nothing is hidden or when
	 * `showAll` is on.
	 */
	hiddenCount: number;
	/** Distinct tag count overall (the N in "pokaż wszystkie (N)"). */
	total: number;
};

/**
 * Which chips the cloud shows.
 *
 * Collapsed (default): `count >= TAG_MIN_COUNT` OR `isUserEdited` (a tag the
 * user set by hand is a decision, and a decision never vanishes for being
 * rare), in server order, capped at `TAG_CLOUD_LIMIT`. The substring filter
 * applies BEFORE the cap so typing narrows within the whole eligible set,
 * not within the first 15. Selected names are always present — appended if
 * the threshold, the cap or the query would have dropped them, so an active
 * narrowing can never become invisible (the empty-result bar would name a tag
 * the user cannot find to un-toggle).
 */
export function buildTagCloud(input: TagCloudInput): TagCloud {
	const { tags, selected, showAll } = input;
	// Tag names are ASCII-canonical (`normalizeTag` strips Polish diacritics at
	// write time), so the query must be folded the same way or "głos" never
	// matches `glos` — the same symmetry rule the FTS search phrase follows
	// (impl-review phase 3, F3). One shared fold, never a second table.
	const q = foldPolishDiacritics(input.query).trim().toLowerCase();

	const eligible = showAll
		? [...tags]
		: tags.filter((t) => t.count >= TAG_MIN_COUNT || t.isUserEdited);
	const matching = q ? eligible.filter((t) => t.name.includes(q)) : eligible;
	const capped = showAll ? matching : matching.slice(0, TAG_CLOUD_LIMIT);

	const visible = [...capped];
	const shown = new Set(visible.map((t) => t.name));
	for (const name of selected) {
		if (shown.has(name)) continue;
		// Selected but hidden by threshold/cap/query — or gone from the ranked
		// list entirely (deleted since it was toggled): still render, count 0.
		visible.push(
			tags.find((t) => t.name === name) ?? {
				name,
				count: 0,
				isUserEdited: false,
			},
		);
		shown.add(name);
	}

	// What "pokaż wszystkie" would add: everything not shown right now, ignoring
	// the query (the query is the user's own narrowing, not the cloud's).
	const hiddenCount = showAll
		? 0
		: tags.filter((t) => !shown.has(t.name)).length;

	return { visible, hiddenCount, total: tags.length };
}
