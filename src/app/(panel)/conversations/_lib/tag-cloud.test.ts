import { describe, expect, it } from "vitest";

import {
	buildTagCloud,
	type CloudTag,
	TAG_CLOUD_LIMIT,
	TAG_MIN_COUNT,
} from "./tag-cloud";

// The server order is `count desc, name asc`; fixtures are written in that
// order so the cloud's "in ranking order" claims are checked against the
// order actually received, not re-sorted here.
const t = (name: string, count: number, isUserEdited = false): CloudTag => ({
	name,
	count,
	isUserEdited,
});

const names = (cloud: { visible: CloudTag[] }) =>
	cloud.visible.map((c) => c.name);

const padded = (i: number) => `tag-${String(i).padStart(2, "0")}`;

describe("buildTagCloud — collapsed (default) cloud", () => {
	it("hides tags below the threshold and keeps ranking order", () => {
		const tags = [
			t("automatyzacja", 7),
			t("system", 3),
			t("crm", 1),
			t("demo", 1),
		];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "",
		});
		expect(names(cloud)).toEqual(["automatyzacja", "system"]);
		expect(cloud.hiddenCount).toBe(2);
		expect(cloud.total).toBe(4);
	});

	it("shows a once-used tag anyway when it is user-edited", () => {
		const tags = [t("system", 3), t("moj-wybor", 1, true), t("crm", 1)];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "",
		});
		expect(names(cloud)).toEqual(["system", "moj-wybor"]);
		expect(cloud.hiddenCount).toBe(1);
	});

	it(`caps the cloud at ${TAG_CLOUD_LIMIT} chips and counts the overflow as hidden`, () => {
		const tags = Array.from({ length: 20 }, (_, i) =>
			t(padded(i), TAG_MIN_COUNT),
		);
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "",
		});
		expect(cloud.visible).toHaveLength(TAG_CLOUD_LIMIT);
		expect(names(cloud)[0]).toBe("tag-00");
		expect(names(cloud)[TAG_CLOUD_LIMIT - 1]).toBe("tag-14");
		expect(cloud.hiddenCount).toBe(5);
	});

	it("is exactly the threshold that decides: count == TAG_MIN_COUNT is shown", () => {
		const tags = [
			t("na-progu", TAG_MIN_COUNT),
			t("pod-progiem", TAG_MIN_COUNT - 1),
		];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "",
		});
		expect(names(cloud)).toEqual(["na-progu"]);
	});

	it("reports nothing hidden when every tag is visible", () => {
		const tags = [t("a", 5), t("b", 2)];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "",
		});
		expect(cloud.hiddenCount).toBe(0);
	});
});

describe("buildTagCloud — 'pokaż wszystkie'", () => {
	it("lifts BOTH the threshold and the cap", () => {
		const tags = [
			...Array.from({ length: 18 }, (_, i) => t(`czesty-${i}`, 2)),
			t("rzadki", 1),
		];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: true,
			query: "",
		});
		expect(cloud.visible).toHaveLength(19);
		expect(names(cloud).at(-1)).toBe("rzadki");
		expect(cloud.hiddenCount).toBe(0);
		expect(cloud.total).toBe(19);
	});
});

describe("buildTagCloud — chip substring filter (client-side)", () => {
	it("narrows chips by case-insensitive substring, within the eligible set", () => {
		const tags = [t("asystent-glosowy", 4), t("voicebot", 3), t("glos", 1)];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "GLOS",
		});
		// `glos` (count 1) stays hidden: the query filters, it does not lift the
		// threshold — only "pokaż wszystkie" does.
		expect(names(cloud)).toEqual(["asystent-glosowy"]);
	});

	it("folds Polish diacritics in the query — tag names are ASCII-canonical", () => {
		// `normalizeTag` writes `glos`, never `głos`; a Polish speaker types the
		// latter. Without the fold the filter silently finds nothing.
		const tags = [t("asystent-glosowy", 4), t("zazalenie", 3), t("crm", 2)];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "Głos",
		});
		expect(names(cloud)).toEqual(["asystent-glosowy"]);
		expect(
			names(
				buildTagCloud({ tags, selected: [], showAll: false, query: "żal" }),
			),
		).toEqual(["zazalenie"]);
	});

	it("applies the query BEFORE the cap, so a match past position 15 is reachable", () => {
		const tags = [
			...Array.from({ length: 16 }, (_, i) => t(padded(i), 2)),
			t("szukany", 2), // 17th in ranking — outside the cap without a query
		];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: false,
			query: "szuk",
		});
		expect(names(cloud)).toEqual(["szukany"]);
	});

	it("reaches a below-threshold tag when 'pokaż wszystkie' and a query combine", () => {
		const tags = [t("system", 3), t("glos", 1)];
		const cloud = buildTagCloud({
			tags,
			selected: [],
			showAll: true,
			query: "glos",
		});
		expect(names(cloud)).toEqual(["glos"]);
	});
});

describe("buildTagCloud — a selected tag never disappears", () => {
	it("keeps a selected tag visible after the query filters it out", () => {
		const tags = [t("automatyzacja", 7), t("system", 3)];
		const cloud = buildTagCloud({
			tags,
			selected: ["system"],
			showAll: false,
			query: "auto",
		});
		expect(names(cloud)).toEqual(["automatyzacja", "system"]);
		expect(cloud.visible[1]).toEqual(t("system", 3));
	});

	it("keeps a selected below-threshold tag visible in the collapsed cloud", () => {
		const tags = [t("system", 3), t("crm", 1)];
		const cloud = buildTagCloud({
			tags,
			selected: ["crm"],
			showAll: false,
			query: "",
		});
		expect(names(cloud)).toEqual(["system", "crm"]);
		// It is shown, so it is not counted as hidden.
		expect(cloud.hiddenCount).toBe(0);
	});

	it("keeps a selected tag past the cap, appended after the capped set", () => {
		const tags = Array.from({ length: 20 }, (_, i) => t(padded(i), 2));
		const cloud = buildTagCloud({
			tags,
			selected: ["tag-19"],
			showAll: false,
			query: "",
		});
		expect(cloud.visible).toHaveLength(TAG_CLOUD_LIMIT + 1);
		expect(names(cloud).at(-1)).toBe("tag-19");
		expect(cloud.hiddenCount).toBe(4);
	});

	it("still renders a selected name that is no longer in the ranked list (count 0)", () => {
		// The tag was toggled, then its last row was deleted on the detail page
		// and the cloud refetched: the narrowing is still active in state and
		// must stay un-togglable, not vanish.
		const cloud = buildTagCloud({
			tags: [t("system", 3)],
			selected: ["znikniety"],
			showAll: false,
			query: "",
		});
		expect(cloud.visible).toEqual([
			t("system", 3),
			{ name: "znikniety", count: 0, isUserEdited: false },
		]);
	});

	it("does not duplicate a selected tag that is already visible", () => {
		const tags = [t("system", 3)];
		const cloud = buildTagCloud({
			tags,
			selected: ["system"],
			showAll: false,
			query: "",
		});
		expect(names(cloud)).toEqual(["system"]);
	});
});
