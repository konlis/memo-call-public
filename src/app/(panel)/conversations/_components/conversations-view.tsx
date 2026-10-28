"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import {
	SEARCH_MAX_CHARS,
	SEARCH_MIN_CHARS,
	UNASSIGNED_PROJECT,
} from "~/server/conversations/filter";
import { categorySchema } from "~/server/llm/schemas";
import { api, type RouterOutputs } from "~/trpc/react";

import { sortByPolishName } from "../../_lib/contact-order";
import { counterpartyLabel } from "../../_lib/counterparty-label";
import { PAGE_SIZE } from "../_lib/list-config";
import { buildTagCloud, TAG_MIN_COUNT } from "../_lib/tag-cloud";
import { TagMergePanel } from "./tag-merge-panel";

type Category = "praca" | "prywatne";
type Filter = "wszystkie" | Category;
type Row = RouterOutputs["conversations"]["list"]["items"][number];

const FILTERS: { value: Filter; label: string }[] = [
	{ value: "wszystkie", label: "Wszystkie" },
	{ value: "praca", label: "Praca" },
	{ value: "prywatne", label: "Prywatne" },
];

const CATEGORY_LABEL: Record<Category, string> = {
	praca: "Praca",
	prywatne: "Prywatne",
};

// Project-picker optgroups, in the schema's own order (same source as the
// projects view, so the two can't drift if the enum ever grows).
const CATEGORIES = categorySchema.options;

const STATUS_BADGE: Record<
	Row["status"],
	{ label: string; className: string }
> = {
	in_progress: {
		label: "W toku",
		className: "bg-amber-500/15 text-amber-200 ring-amber-400/30",
	},
	failed: {
		label: "Błąd",
		className: "bg-red-500/15 text-red-200 ring-red-400/30",
	},
	done: {
		label: "Gotowe",
		className: "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30",
	},
};

// Deterministic UTC slice — a locale-formatted date would differ between the SSR
// render and the client hydration and trip a hydration mismatch.
function formatTimestamp(d: Date): string {
	return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ConversationsView() {
	const [filter, setFilter] = useState<Filter>("wszystkie");
	// FR-019: in-memory tag filter (AND across the selected names), resets on
	// reload — matching the shipped category filter (persistence is deferred).
	const [selectedTags, setSelectedTags] = useState<string[]>([]);
	// The primary axis. `null` = no narrowing; `UNASSIGNED_PROJECT` = the
	// conversations no project owns (otherwise unreachable by any filter).
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	// FR-025: "what did we settle with X", across projects. Holds a contact ID,
	// never a number — the number stays out of UI state and the query key.
	const [selectedContact, setSelectedContact] = useState<string | null>(null);
	const projectFilterId = useId();
	const contactFilterId = useId();
	const searchId = useId();
	const tagFilterId = useId();

	// Full-text phrase. Two pieces of state on purpose: `searchInput` is what the
	// box shows (updates per keystroke), `searchPhrase` is what the query sees
	// (updates ~300 ms after the last keystroke). Sending per keystroke would
	// fire one FTS query per character and race their responses.
	const [searchInput, setSearchInput] = useState("");
	const [searchPhrase, setSearchPhrase] = useState("");
	useEffect(() => {
		const t = setTimeout(() => setSearchPhrase(searchInput.trim()), 300);
		return () => clearTimeout(t);
	}, [searchInput]);
	// Below the shared threshold the router would reject the input, so the
	// phrase is simply not active yet (same rule server-side — one constant).
	const activePhrase =
		searchPhrase.length >= SEARCH_MIN_CHARS ? searchPhrase : null;

	// Ranked canonical tag names (count desc) → the toggleable filter chips.
	// The cloud rule — threshold ≥ TAG_MIN_COUNT, cap, chip filter, selected
	// always visible — is the pure `buildTagCloud`; these two states are its
	// only inputs that live here. Both are chip-UI state, NOT list narrowings:
	// they never enter `filterObj` and `clearAll` leaves them alone.
	const tagsQuery = api.tags.listWithCounts.useQuery();
	const allTags = tagsQuery.data ?? [];
	const [tagChipQuery, setTagChipQuery] = useState("");
	const [showAllTags, setShowAllTags] = useState(false);
	const cloud = buildTagCloud({
		tags: allTags,
		selected: selectedTags,
		showAll: showAllTags,
		query: tagChipQuery,
	});

	// The project picker's options. Same source as the projects view, so the
	// per-project conversation count the user sees there is the number this
	// filter must reproduce.
	const projectsQuery = api.projects.list.useQuery();
	const allProjects = projectsQuery.data ?? [];

	// Only contacts WITH a number can match a conversation (the router joins on
	// the number), so a number-less contact would be an option that always
	// yields an empty list. Polish order, like `/contacts` and `/call`.
	const contactsQuery = api.contacts.list.useQuery();
	const numberedContacts = sortByPolishName(
		(contactsQuery.data ?? []).filter((c) => c.e164 !== null),
	);
	// The selected contact is looked up in the FULL list: one that has since
	// lost its number still exists (so not "usunięty kontakt") and still needs
	// an option of its own, or the select would read "Wszyscy rozmówcy" while
	// the list stays narrowed.
	const selectedContactName =
		contactsQuery.data?.find((c) => c.id === selectedContact)?.name ?? null;
	const selectedContactUnlisted =
		selectedContact !== null &&
		!numberedContacts.some((c) => c.id === selectedContact);

	// A global merge renames `from` out of existence, so an active filter on it
	// would silently match nothing (the chip would still be rendered, count 0, by
	// buildTagCloud's selected-always-visible rule). Re-point it onto the
	// survivor instead — the user's narrowing survives the vocabulary edit.
	function onTagsMerged(from: string, to: string) {
		setSelectedTags((prev) => {
			if (!prev.includes(from)) return prev;
			const without = prev.filter((t) => t !== from);
			return without.includes(to) ? without : [...without, to];
		});
	}

	function toggleTag(name: string) {
		setSelectedTags((prev) =>
			prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
		);
	}

	// Build the filter object only from active constraints, then OMIT it entirely
	// when nothing is active so the query key equals the server prefetch's
	// `{ limit }` (otherwise the SSR-hydrated first page is discarded + refetched —
	// see list-config.ts). Tags are sorted so a given set yields ONE query key
	// regardless of the order chips were toggled in. `selectedProject` follows the
	// SAME rule — it is a `string | null` rather than a nullable field on the wire
	// precisely so "unassigned" can be an active value instead of an empty one
	// (see `~/server/conversations/filter`).
	const filterObj: {
		category?: Category;
		tags?: string[];
		projectId?: string;
		contactId?: string;
		q?: string;
	} = {};
	if (filter !== "wszystkie") filterObj.category = filter;
	if (selectedTags.length > 0) filterObj.tags = [...selectedTags].sort();
	if (selectedProject !== null) filterObj.projectId = selectedProject;
	if (selectedContact !== null) filterObj.contactId = selectedContact;
	if (activePhrase !== null) filterObj.q = activePhrase;
	const input =
		Object.keys(filterObj).length > 0
			? { filter: filterObj, limit: PAGE_SIZE }
			: { limit: PAGE_SIZE };

	const query = api.conversations.list.useInfiniteQuery(input, {
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	const items = query.data?.pages.flatMap((page) => page.items) ?? [];

	// The active narrowings, spelled out. With four AND-ed filters an empty
	// page that does not say WHICH constraints produced it is the main risk of
	// AND semantics — the user reads "no conversations" when the truth is "no
	// conversations with this tag in that project". Derived from the same state
	// the query is built from, so the bar can never disagree with the result.
	const activeConstraints: { key: string; label: string }[] = [];
	if (filter !== "wszystkie") {
		activeConstraints.push({
			key: "category",
			label: `kategoria: ${CATEGORY_LABEL[filter]}`,
		});
	}
	if (selectedProject !== null) {
		const projectLabel =
			selectedProject === UNASSIGNED_PROJECT
				? "bez projektu"
				: (allProjects.find((p) => p.id === selectedProject)?.name ??
					selectedProject);
		activeConstraints.push({
			key: "project",
			label: `projekt: ${projectLabel}`,
		});
	}
	if (selectedContact !== null) {
		activeConstraints.push({
			key: "contact",
			label: `kontakt: ${selectedContactName ?? "usunięty kontakt"}`,
		});
	}
	if (selectedTags.length > 0) {
		activeConstraints.push({
			key: "tags",
			label: `tagi: ${selectedTags.join(", ")}`,
		});
	}
	if (activePhrase !== null) {
		activeConstraints.push({ key: "q", label: `fraza: „${activePhrase}”` });
	}

	function clearAll() {
		setFilter("wszystkie");
		setSelectedTags([]);
		setSelectedProject(null);
		setSelectedContact(null);
		setSearchInput("");
		// Skip the debounce on clear — the phrase must drop out of the query key
		// together with the other three, not 300 ms later.
		setSearchPhrase("");
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<h1 className="font-bold text-2xl tracking-tight">Rozmowy</h1>
				<div className="flex flex-wrap items-center gap-2">
					<fieldset
						aria-label="Filtr kategorii"
						className="flex gap-1 rounded-lg border-0 bg-white/5 p-1"
					>
						{FILTERS.map((f) => (
							<button
								aria-pressed={filter === f.value}
								className={`rounded-md px-3 py-1.5 font-medium text-sm transition ${
									filter === f.value
										? "bg-[#a855f7] text-white"
										: "text-white/70 hover:text-white"
								}`}
								key={f.value}
								onClick={() => setFilter(f.value)}
								type="button"
							>
								{f.label}
							</button>
						))}
					</fieldset>
					<label className="sr-only" htmlFor={projectFilterId}>
						Filtr projektu
					</label>
					<select
						className="rounded-lg bg-white/5 px-3 py-2 text-sm text-white/80 ring-1 ring-white/15 transition focus:text-white focus:ring-[#a855f7]"
						id={projectFilterId}
						// `""` is the DOM's representation of "no narrowing"; `null` is the
						// state's. They are mapped here and nowhere else — `""` must never
						// reach `filterObj`, or the router would receive an empty string
						// that `z.string().min(1)` rejects.
						onChange={(e) => setSelectedProject(e.target.value || null)}
						value={selectedProject ?? ""}
					>
						<option value="">Wszystkie projekty</option>
						<option value={UNASSIGNED_PROJECT}>Bez projektu</option>
						{CATEGORIES.map((c) => {
							const inCategory = allProjects.filter((p) => p.category === c);
							if (inCategory.length === 0) return null;
							return (
								// Grouped by category like the projects view (FR-014): a
								// project only ever belongs to one, and the same name can
								// legitimately exist in both.
								<optgroup key={c} label={CATEGORY_LABEL[c]}>
									{inCategory.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name} ({p.conversationCount})
										</option>
									))}
								</optgroup>
							);
						})}
					</select>
					{/* Hidden while no contact carries a number — every option would
					    match nothing. Kept visible while one is SELECTED even if it
					    has since lost its number, so the active narrowing stays
					    visible and clearable here, not only in "Zawężono:". */}
					{numberedContacts.length > 0 || selectedContact !== null ? (
						<>
							<label className="sr-only" htmlFor={contactFilterId}>
								Filtr kontaktu
							</label>
							<select
								className="max-w-[12rem] rounded-lg bg-white/5 px-3 py-2 text-sm text-white/80 ring-1 ring-white/15 transition focus:text-white focus:ring-[#a855f7]"
								id={contactFilterId}
								// Same `""` ↔ `null` mapping as the project picker above.
								onChange={(e) => setSelectedContact(e.target.value || null)}
								value={selectedContact ?? ""}
							>
								<option value="">Wszyscy rozmówcy</option>
								{selectedContactUnlisted ? (
									<option value={selectedContact ?? ""}>
										{selectedContactName ?? "usunięty kontakt"}
									</option>
								) : null}
								{numberedContacts.map((c) => (
									<option key={c.id} value={c.id}>
										{c.name}
									</option>
								))}
							</select>
						</>
					) : null}
				</div>
			</div>

			<div className="flex flex-col gap-1">
				<label className="sr-only" htmlFor={searchId}>
					Szukaj w rozmowach
				</label>
				<input
					autoComplete="off"
					className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-white ring-1 ring-white/15 transition placeholder:text-white/40 focus:ring-[#a855f7]"
					id={searchId}
					maxLength={SEARCH_MAX_CHARS}
					onChange={(e) => setSearchInput(e.target.value)}
					placeholder="Szukaj w transkrypcji i podsumowaniu…"
					type="search"
					value={searchInput}
				/>
				{searchInput.trim().length > 0 &&
				searchInput.trim().length < SEARCH_MIN_CHARS ? (
					<p className="text-white/40 text-xs">
						Wpisz co najmniej {SEARCH_MIN_CHARS} znaki.
					</p>
				) : null}
			</div>

			{activeConstraints.length > 0 ? (
				<div
					aria-label="Aktywne zawężenia"
					className="flex flex-wrap items-center gap-2 text-xs"
					role="status"
				>
					<span className="text-white/50">Zawężono:</span>
					{activeConstraints.map((c) => (
						<span
							className="rounded-full bg-white/10 px-2 py-0.5 text-white/80"
							key={c.key}
						>
							{c.label}
						</span>
					))}
					<button
						className="rounded-md px-2 py-0.5 font-medium text-white/70 underline-offset-2 transition hover:text-white hover:underline"
						onClick={clearAll}
						type="button"
					>
						Wyczyść wszystko
					</button>
				</div>
			) : null}

			{allTags.length > 0 ? (
				<fieldset
					aria-label="Filtr tagów"
					className="flex flex-col gap-2 border-0 p-0"
				>
					<div className="flex flex-wrap items-center gap-2">
						<label className="sr-only" htmlFor={tagFilterId}>
							Filtruj tagi
						</label>
						<input
							autoComplete="off"
							className="w-48 rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white ring-1 ring-white/15 transition placeholder:text-white/40 focus:ring-[#a855f7]"
							id={tagFilterId}
							onChange={(e) => setTagChipQuery(e.target.value)}
							placeholder="Filtruj tagi…"
							type="search"
							value={tagChipQuery}
						/>
						{/* Rendered UNCONDITIONALLY — the fieldset above already requires
						    `allTags.length > 0`, so there is always something to expand.
						    It used to be gated on `cloud.hiddenCount > 0`, which hid the
						    toggle whenever EVERY tag cleared the ≥2 threshold and the list
						    fit under the cap. Since this button is the only setter of
						    `showAllTags`, that also made the merge panel below unreachable
						    — in exactly the `faktury` 4× next to `faktura` 3× case phase 4
						    exists for (impl-review phase 4, F1). */}
						<button
							// A state toggle (like the chips and the category buttons), not a
							// disclosure: there is no region it expands, so `aria-pressed`,
							// not `aria-expanded` (impl-review phase 3, F5).
							aria-pressed={showAllTags}
							className="rounded-md px-2 py-1 font-medium text-white/70 text-xs underline-offset-2 transition hover:text-white hover:underline"
							onClick={() => setShowAllTags((v) => !v)}
							type="button"
						>
							{showAllTags
								? `Pokaż tylko częste (≥${TAG_MIN_COUNT})`
								: `Pokaż wszystkie (${cloud.total})`}
						</button>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{cloud.visible.map((tag) => {
							const active = selectedTags.includes(tag.name);
							return (
								<button
									aria-pressed={active}
									className={`rounded-full px-3 py-1 font-medium text-xs ring-1 transition ${
										active
											? "bg-[#a855f7] text-white ring-[#a855f7]"
											: "bg-white/5 text-white/70 ring-white/15 hover:text-white"
									}`}
									key={tag.name}
									onClick={() => toggleTag(tag.name)}
									title={
										tag.isUserEdited ? "Tag ustawiony przez Ciebie" : undefined
									}
									type="button"
								>
									{tag.name}
									{tag.isUserEdited ? (
										// `title` is hover-only; this reaches keyboard + screen-reader
										// users too (impl-review phase 3, F5).
										<span className="sr-only"> (ustawiony ręcznie)</span>
									) : null}{" "}
									{/* A real space, not only margin: the accessible name and any
									    text extraction read "faktury 3", never "faktury3". */}
									<span
										className={`ml-1 tabular-nums ${active ? "text-white/80" : "text-white/40"}`}
									>
										{tag.count}
									</span>
								</button>
							);
						})}
						{cloud.visible.length === 0 ? (
							<p className="text-white/40 text-xs">
								{/* Two different empties: the user's filter matched nothing,
								    or the threshold alone hid everything (a fresh instance with
								    a handful of conversations — every tag used once). The second
								    must not read as a filter result (impl-review phase 3, F1). */}
								{tagChipQuery.trim().length > 0
									? `Żaden tag nie pasuje do „${tagChipQuery.trim()}”.`
									: `Żaden tag nie występuje jeszcze ${TAG_MIN_COUNT} razy — użyj „Pokaż wszystkie”.`}
							</p>
						) : null}
					</div>
					{selectedTags.length > 1 ? (
						<p className="text-white/40 text-xs">
							Pokazuje rozmowy ze wszystkimi zaznaczonymi tagami.
						</p>
					) : null}
					{/* Merging is only offered on the EXPANDED cloud: the variants worth
					    merging are exactly the ones the ≥2 threshold hides, and the
					    counts you compare to decide are only all on screen here. Fed
					    the full ranked list, not `cloud.visible`. */}
					{showAllTags ? (
						<TagMergePanel onMerged={onTagsMerged} tags={allTags} />
					) : null}
				</fieldset>
			) : null}

			{query.isPending ? (
				<p className="text-white/60">Ładowanie…</p>
			) : query.isError ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200"
					role="alert"
				>
					Nie udało się wczytać rozmów.
				</p>
			) : items.length === 0 ? (
				activeConstraints.length > 0 ? (
					<div className="flex flex-col gap-2 text-white/60">
						<p>
							Brak rozmów dla aktywnych zawężeń (
							{activeConstraints.map((c) => c.label).join("; ")}).
						</p>
						<button
							className="self-start rounded-md bg-white/10 px-3 py-1.5 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 hover:text-white"
							onClick={clearAll}
							type="button"
						>
							Wyczyść wszystko
						</button>
					</div>
				) : (
					<p className="text-white/60">Brak rozmów do wyświetlenia.</p>
				)
			) : (
				<ul className="flex flex-col gap-3">
					{items.map((row) => (
						<ConversationRow key={row.id} row={row} />
					))}
				</ul>
			)}

			{query.hasNextPage ? (
				<button
					className="self-center rounded-md bg-white/10 px-4 py-2 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 hover:text-white disabled:opacity-50"
					disabled={query.isFetchingNextPage}
					onClick={() => void query.fetchNextPage()}
					type="button"
				>
					{query.isFetchingNextPage ? "Wczytywanie…" : "Wczytaj więcej"}
				</button>
			) : null}
		</div>
	);
}

function ConversationRow({ row }: { row: Row }) {
	const badge = STATUS_BADGE[row.status];
	const categoryLabel = row.category
		? (CATEGORY_LABEL[row.category as Category] ?? row.category)
		: "Nieprzypisana";
	// FR-016 auto/override indicator — only meaningful once classified; an
	// unassigned row already reads "Nieprzypisana" and gets no auto/ręcznie pill.
	const overrideLabel = row.category
		? row.categoryOverridden || row.projectOverridden
			? "ręcznie"
			: "auto"
		: null;
	// No summary yet ⇒ a status-aware placeholder (never a blank row — the row
	// must still surface; voicemail_processed_not_gated).
	const placeholder =
		row.status === "failed" ? "Analiza nie powiodła się." : "Przetwarzanie…";

	return (
		<li>
			<Link
				className="block rounded-lg bg-white/5 p-4 ring-1 ring-white/10 transition hover:bg-white/10"
				href={`/conversations/${row.id}`}
			>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2 text-sm">
						<span className="rounded-full bg-white/10 px-2 py-0.5 text-white/80">
							{categoryLabel}
						</span>
						<span className="text-white/50">{row.projectName ?? "—"}</span>
						{overrideLabel ? (
							<span
								className={`rounded-full px-2 py-0.5 font-medium text-xs ring-1 ${
									overrideLabel === "ręcznie"
										? "bg-sky-500/15 text-sky-200 ring-sky-400/30"
										: "bg-violet-500/15 text-violet-200 ring-violet-400/30"
								}`}
							>
								{overrideLabel}
							</span>
						) : null}
					</div>
					<span
						className={`rounded-full px-2 py-0.5 font-medium text-xs ring-1 ${badge.className}`}
					>
						{badge.label}
					</span>
				</div>
				<CounterpartyLine counterparty={row.counterparty} />
				{row.summary ? (
					<p className="mt-2 line-clamp-2 text-sm text-white/80">
						{row.summary}
					</p>
				) : (
					<p className="mt-2 text-sm text-white/40 italic">{placeholder}</p>
				)}
				<p className="mt-2 text-white/40 text-xs">
					{formatTimestamp(row.createdAt)}
				</p>
			</Link>
		</li>
	);
}

// FR-025: "with whom", on every row, without opening the conversation. The
// precedence is `counterpartyLabel`'s; this only decides how each source looks:
// a contact name is plain, the operator's hint is visibly NOT the user's own
// label, and a state is dimmed. Nothing at all for a pre-FR-025 row.
function CounterpartyLine({
	counterparty,
}: {
	counterparty: Row["counterparty"];
}) {
	const label = counterpartyLabel(counterparty);
	if (label === null) return null;
	return (
		<p className="mt-2 flex min-w-0 items-baseline gap-2 text-sm">
			<span
				className={`truncate ${
					label.source === "state"
						? "text-white/40 italic"
						: label.source === "number"
							? "text-white/80 tabular-nums"
							: "font-medium text-white/90"
				}`}
			>
				{label.primary}
			</span>
			{label.source === "operator" ? (
				<span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">
					od operatora
				</span>
			) : null}
			{label.secondary ? (
				<span className="hidden shrink-0 text-white/40 text-xs tabular-nums sm:inline">
					{label.secondary}
				</span>
			) : null}
		</p>
	);
}
