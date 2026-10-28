"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { createContactInput } from "~/server/contacts/schema";
import { categorySchema } from "~/server/llm/schemas";
import { normalizeTag } from "~/server/tags/normalize";
import { api, type RouterOutputs } from "~/trpc/react";

import { sortByPolishName } from "../../../_lib/contact-order";
import { counterpartyLabel } from "../../../_lib/counterparty-label";

type Category = "praca" | "prywatne";
type Detail = RouterOutputs["conversations"]["getById"];

const CATEGORY_LABEL: Record<Category, string> = {
	praca: "Praca",
	prywatne: "Prywatne",
};

const CATEGORIES = categorySchema.options;

const STATUS_BADGE: Record<
	Detail["status"],
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

// Deterministic UTC slice — mirrors the list view. A locale-formatted date would
// differ between SSR and client hydration and trip a hydration mismatch.
function formatTimestamp(d: Date): string {
	return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function BackLink() {
	return (
		<Link
			className="text-sm text-white/60 transition hover:text-white"
			href="/conversations"
		>
			← Rozmowy
		</Link>
	);
}

export function ConversationDetail({ id }: { id: string }) {
	// Bounded poll while a re-analyze job is in flight: re-read getById every 3 s
	// until `reanalyzing` flips false, then stop. Repeated query loads only — NO
	// SSE/WebSocket (FR-023 page-load-refresh model). Self-terminating + negligible:
	// active only for the seconds a job runs. The result lands without a manual reload.
	const detail = api.conversations.getById.useQuery(
		{ id },
		{
			refetchInterval: (query) =>
				query.state.data?.reanalyzing ? 3000 : false,
		},
	);

	if (detail.isPending) {
		return (
			<div className="flex flex-col gap-4">
				<BackLink />
				<p className="text-white/60">Ładowanie…</p>
			</div>
		);
	}

	// NOT_FOUND (foreign/unknown id) or any load failure → graceful in-panel
	// not-found. Keeps the panel nav and never reveals whether the id exists.
	if (detail.isError) {
		return (
			<div className="flex flex-col gap-4">
				<BackLink />
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200"
					role="alert"
				>
					Nie znaleziono rozmowy.
				</p>
			</div>
		);
	}

	return <DetailLoaded detail={detail.data} />;
}

function DetailLoaded({ detail }: { detail: Detail }) {
	const router = useRouter();
	const utils = api.useUtils();
	const [deleteError, setDeleteError] = useState<string | null>(null);
	// Lifted so the Re-analyze control can disable itself while the transcript is
	// being edited (Save and Re-analyze are mutually exclusive — re-analyzing an
	// unsaved draft would analyze the stale persisted transcript).
	const [editingTranscript, setEditingTranscript] = useState(false);

	const del = api.conversations.delete.useMutation({
		onSuccess: async () => {
			// Refresh the list (the row is gone) and projects (per-project counts
			// drop), then navigate back to the list view.
			await Promise.all([
				utils.conversations.list.invalidate(),
				utils.projects.list.invalidate(),
			]);
			router.push("/conversations");
		},
		// Surface the server message (e.g. a NOT_FOUND from a concurrent delete).
		onError: (err) => setDeleteError(err.message),
	});

	const status = STATUS_BADGE[detail.status];
	const segments = detail.transcriptSegments ?? [];

	// FR-016 auto/override indicator. Either flag ⇒ the user owns the pair
	// ("ręcznie"); an assigned-but-untouched classification is "auto"; a NULL
	// category (no_auto_assignment or no projects) is "Nieprzypisana".
	const classified = detail.category != null;
	const overridden = detail.categoryOverridden || detail.projectOverridden;

	// window.confirm is acceptable for the MVP (single-user, page-load model) —
	// same pattern as projects-view.tsx. Delete is irreversible (transcript +
	// analysis are destroyed), so the confirm guards an accidental click.
	function onDelete() {
		setDeleteError(null);
		if (!window.confirm("Usunąć rozmowę? Tej operacji nie można cofnąć.")) {
			return;
		}
		del.mutate({ id: detail.id });
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center justify-between gap-4">
				<BackLink />
				<div className="flex items-center gap-3">
					<span
						className={`rounded-full px-2 py-0.5 font-medium text-xs ring-1 ${status.className}`}
					>
						{status.label}
					</span>
					<button
						className="rounded-md px-3 py-1.5 font-medium text-red-200 text-sm ring-1 ring-red-400/30 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={del.isPending}
						onClick={onDelete}
						type="button"
					>
						{del.isPending ? "Usuwanie…" : "Usuń rozmowę"}
					</button>
				</div>
			</div>

			{deleteError ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{deleteError}
				</p>
			) : null}

			<div className="flex flex-col gap-1">
				<h1 className="font-bold text-2xl tracking-tight">Rozmowa</h1>
				<p className="text-sm text-white/40">
					{formatTimestamp(detail.createdAt)}
					{detail.transcriptLanguage ? ` · ${detail.transcriptLanguage}` : ""}
				</p>
			</div>

			{detail.counterparty ? (
				<CounterpartySection
					conversationId={detail.id}
					counterparty={detail.counterparty}
				/>
			) : null}

			{/* Classification block + override form. */}
			<section className="flex flex-col gap-4 rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
				<div className="flex items-center gap-2 text-sm">
					<span className="font-semibold text-white/90">Klasyfikacja</span>
					{classified ? (
						<span
							className={`rounded-full px-2 py-0.5 font-medium text-xs ring-1 ${
								overridden
									? "bg-sky-500/15 text-sky-200 ring-sky-400/30"
									: "bg-violet-500/15 text-violet-200 ring-violet-400/30"
							}`}
						>
							{overridden ? "ręcznie" : "auto"}
						</span>
					) : (
						<span className="rounded-full bg-white/10 px-2 py-0.5 font-medium text-white/60 text-xs ring-1 ring-white/15">
							Nieprzypisana
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 text-sm">
					<span className="rounded-full bg-white/10 px-2 py-0.5 text-white/80">
						{detail.category
							? (CATEGORY_LABEL[detail.category as Category] ?? detail.category)
							: "—"}
					</span>
					<span className="text-white/50">{detail.projectName ?? "—"}</span>
				</div>

				<OverrideForm
					conversationId={detail.id}
					currentCategory={detail.category as Category | null}
					currentProjectId={detail.projectId}
				/>
			</section>

			{/* Analysis (FR-004) + Re-analyze control & indicators (FR-021). */}
			<AnalysisSection detail={detail} editingTranscript={editingTranscript} />

			{/* Tags (FR-017/018) — editable, sourced from the `tags` table (NOT the
			    immutable analysis.candidateTags blob). Its own always-visible section
			    so tags stay curatable even while analysis is processing/failed. */}
			<TagsSection conversationId={detail.id} tags={detail.tags} />

			{/* Transcript (FR-003), speaker-labelled — editable per turn (FR-020). */}
			<TranscriptSection
				conversationId={detail.id}
				editing={editingTranscript}
				onEditingChange={setEditingTranscript}
				segments={segments}
				transcriptEditedAt={detail.transcriptEditedAt}
			/>
		</div>
	);
}

// FR-004 analysis render + FR-021 re-analyze control. The prior analysis stays
// visible THROUGHOUT a re-analyze (never replaced by a spinner): an in-progress
// run shows a "re-analizuje…" badge above the unchanged content; a failed run shows
// a non-destructive hint. `reanalyzedAt` stamps the last successful re-run.
function AnalysisSection({
	detail,
	editingTranscript,
}: {
	detail: Detail;
	editingTranscript: boolean;
}) {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const analysis = detail.analysis;
	const canReanalyze = (detail.transcriptSegments ?? []).length > 0;

	const reanalyze = api.conversations.reanalyze.useMutation({
		onSuccess: async () => {
			setError(null);
			// Re-read so `reanalyzing` flips true → the bounded poll takes over and
			// surfaces the fresh analysis when the job lands.
			await utils.conversations.getById.invalidate({ id: detail.id });
		},
		onError: (err) => setError(err.message),
	});

	return (
		<section className="flex flex-col gap-4 rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<h2 className="font-semibold text-lg text-white/90">Analiza</h2>
					{detail.reanalyzing ? (
						<span
							className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-200 text-xs ring-1 ring-amber-400/30"
							title="Trwa ponowna analiza edytowanego transkryptu"
						>
							re-analizuje…
						</span>
					) : null}
				</div>
				{canReanalyze ? (
					<button
						className="rounded-md px-3 py-1.5 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={
							detail.reanalyzing || editingTranscript || reanalyze.isPending
						}
						onClick={() => reanalyze.mutate({ conversationId: detail.id })}
						title={
							editingTranscript
								? "Zapisz lub anuluj edycję transkryptu, aby przeanalizować ponownie"
								: undefined
						}
						type="button"
					>
						{reanalyze.isPending ? "Wysyłanie…" : "Przeanalizuj ponownie"}
					</button>
				) : null}
			</div>

			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}

			{/* Non-destructive failure hint — the prior analysis below is untouched. */}
			{detail.lastReanalyzeFailed ? (
				<p className="rounded-md bg-red-500/10 px-3 py-2 text-red-200/80 text-sm">
					Ostatnia ponowna analiza nie powiodła się — poprzednia analiza
					pozostała bez zmian.
				</p>
			) : null}

			{detail.reanalyzedAt ? (
				<p className="text-white/40 text-xs">
					Przeanalizowano ponownie {formatTimestamp(detail.reanalyzedAt)}
				</p>
			) : null}

			{analysis ? (
				<>
					{analysis.summary ? (
						<p className="text-sm text-white/80">{analysis.summary}</p>
					) : null}
					<AnalysisList items={analysis.keyInsights} title="Kluczowe wnioski" />
					<AnalysisList items={analysis.decisions} title="Decyzje" />
					<AnalysisList items={analysis.actionItems} title="Zadania" />
				</>
			) : (
				<p className="text-sm text-white/40 italic">
					{detail.status === "failed"
						? "Analiza nie powiodła się."
						: "Przetwarzanie…"}
				</p>
			)}
		</section>
	);
}

type Segment = Detail["transcriptSegments"] extends (infer S)[] | null
	? S
	: never;

// FR-020: per-turn transcript editor. View mode renders the speaker-labelled list
// + an "Edytuj" button + an "Edytowano <date>" line when the transcript was edited.
// Edit mode swaps each turn's text for a <textarea> (speaker label stays read-only)
// with Save/Cancel. Save preserves each segment's startMs/endMs (only `text`
// changes) and invalidates getById on success. Editing does NOT auto-trigger
// re-analysis — that is a separate, explicit action.
function TranscriptSection({
	conversationId,
	segments,
	transcriptEditedAt,
	editing,
	onEditingChange,
}: {
	conversationId: string;
	segments: Segment[];
	transcriptEditedAt: Date | null;
	editing: boolean;
	onEditingChange: (editing: boolean) => void;
}) {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	// Seeded on edit-open (NOT prop-synced), mirroring the TagPill draft pattern:
	// view mode reads `segments` directly, so a stale draft while not editing is unused.
	const [drafts, setDrafts] = useState<string[]>(() =>
		segments.map((s) => s.text),
	);

	const update = api.conversations.updateTranscript.useMutation({
		onSuccess: async () => {
			setError(null);
			onEditingChange(false);
			await utils.conversations.getById.invalidate({ id: conversationId });
		},
		onError: (err) => setError(err.message),
	});

	function openEdit() {
		setError(null);
		setDrafts(segments.map((s) => s.text)); // re-seed from the current transcript
		onEditingChange(true);
	}

	function cancel() {
		setError(null);
		onEditingChange(false);
	}

	function save() {
		// Preserve speaker + startMs/endMs; only the edited text changes.
		const next = segments.map((s, i) => ({ ...s, text: drafts[i] ?? s.text }));
		update.mutate({ conversationId, segments: next });
	}

	// Precompute a stable render key per turn (speaker + position). Built OUTSIDE the
	// JSX `key=` prop so it doesn't trip noArrayIndexKey — the transcript is fixed-order
	// and the speaker+index pair is unique within one conversation.
	const keyed = segments.map((seg, index) => ({
		seg,
		index,
		key: `${seg.speaker}-${index}`,
	}));

	return (
		<section className="flex flex-col gap-4 rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-semibold text-lg text-white/90">Transkrypcja</h2>
					{transcriptEditedAt ? (
						<span className="text-white/40 text-xs">
							Edytowano {formatTimestamp(transcriptEditedAt)}
						</span>
					) : null}
				</div>
				{segments.length > 0 && !editing ? (
					<button
						className="rounded-md px-3 py-1.5 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/10"
						onClick={openEdit}
						type="button"
					>
						Edytuj
					</button>
				) : null}
			</div>

			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}

			{segments.length === 0 ? (
				<p className="text-sm text-white/40 italic">Brak transkrypcji.</p>
			) : editing ? (
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<ul className="flex flex-col gap-3">
						{keyed.map(({ seg, index, key }) => (
							<li className="flex flex-col gap-1" key={key}>
								<span className="font-medium text-violet-200 text-xs">
									{seg.speaker}
								</span>
								<textarea
									aria-label={`Tekst wypowiedzi: ${seg.speaker}`}
									className="min-h-16 w-full rounded-md bg-white/10 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
									disabled={update.isPending}
									onChange={(e) =>
										setDrafts((d) => {
											const nextDrafts = [...d];
											nextDrafts[index] = e.target.value;
											return nextDrafts;
										})
									}
									value={drafts[index] ?? ""}
								/>
							</li>
						))}
					</ul>
					<div className="flex items-center gap-2">
						<button
							className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-sm text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
							disabled={update.isPending}
							type="submit"
						>
							{update.isPending ? "Zapisywanie…" : "Zapisz"}
						</button>
						<button
							className="rounded-md px-4 py-2 font-medium text-sm text-white/70 ring-1 ring-white/15 transition hover:bg-white/10 disabled:opacity-50"
							disabled={update.isPending}
							onClick={cancel}
							type="button"
						>
							Anuluj
						</button>
					</div>
				</form>
			) : (
				<ul className="flex flex-col gap-3">
					{keyed.map(({ seg, key }) => (
						<li className="flex flex-col gap-1" key={key}>
							<span className="font-medium text-violet-200 text-xs">
								{seg.speaker}
							</span>
							<p className="text-sm text-white/80">{seg.text}</p>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function AnalysisList({ title, items }: { title: string; items: string[] }) {
	if (items.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			<h3 className="font-medium text-sm text-white/70">{title}</h3>
			<ul className="flex list-disc flex-col gap-1 pl-5">
				{items.map((item, i) => (
					// Index key is safe: analysis arrays are immutable once persisted.
					// biome-ignore lint/suspicious/noArrayIndexKey: immutable, stable-order analysis list
					<li className="text-sm text-white/80" key={i}>
						{item}
					</li>
				))}
			</ul>
		</div>
	);
}

type Tag = Detail["tags"][number];

// FR-017/018: editable tags sourced from the `tags` table. Each tag is a pill
// with inline rename + delete; an add-input below; user-edited tags are visually
// distinguished from LLM-proposed ones; a conversation-level hint appears when
// any tag is user-edited. All mutation errors surface inline (mirrors the
// OverrideForm pattern), never a silent no-op.
function TagsSection({
	conversationId,
	tags,
}: {
	conversationId: string;
	tags: Tag[];
}) {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);

	// On any tag change, re-read the detail (this page reads the table) AND the
	// ranked tag set (the list-filter chips depend on it — a rename here moves a
	// count there). FR-023 page-load refresh model — no realtime, just query
	// invalidation. Re-pointed, NOT dropped, when `distinct` became
	// `listWithCounts` (phase 3): without this line the cloud goes stale after
	// an edit with no error anywhere.
	async function refresh() {
		setError(null);
		await Promise.all([
			utils.conversations.getById.invalidate({ id: conversationId }),
			utils.tags.listWithCounts.invalidate(),
		]);
	}
	const onError = (err: { message: string }) => setError(err.message);

	const addMut = api.tags.add.useMutation({ onSuccess: refresh, onError });
	const renameMut = api.tags.rename.useMutation({
		onSuccess: refresh,
		onError,
	});
	const removeMut = api.tags.remove.useMutation({
		onSuccess: refresh,
		onError,
	});

	const busy = addMut.isPending || renameMut.isPending || removeMut.isPending;
	const userEdited = tags.some((t) => t.isUserEdited);

	return (
		<section className="flex flex-col gap-4 rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
			<div className="flex items-center gap-2">
				<h2 className="font-semibold text-lg text-white/90">Tagi</h2>
				{userEdited ? (
					<span
						className="rounded-full bg-sky-500/15 px-2 py-0.5 font-medium text-sky-200 text-xs ring-1 ring-sky-400/30"
						title="Co najmniej jeden tag został zmieniony ręcznie"
					>
						edytowane przez użytkownika
					</span>
				) : null}
			</div>

			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}

			{tags.length === 0 ? (
				<p className="text-sm text-white/40 italic">Brak tagów.</p>
			) : (
				<div className="flex flex-wrap gap-2">
					{tags.map((tag) => (
						<TagPill
							disabled={busy}
							key={tag.id}
							onRemove={() => removeMut.mutate({ tagId: tag.id })}
							onRename={(name) => renameMut.mutate({ tagId: tag.id, name })}
							tag={tag}
						/>
					))}
				</div>
			)}

			<AddTagForm
				disabled={busy}
				onAdd={(name) => addMut.mutate({ conversationId, name })}
			/>
		</section>
	);
}

// One tag pill. View mode shows the name (click to rename) + a user-edited dot +
// a delete (×) control; edit mode swaps in an inline input. `normalizeTag` (the
// shared module) previews the canonical form so the confirm is disabled when the
// input would normalize to nothing, and a no-op rename (same canonical name) is
// skipped client-side.
function TagPill({
	tag,
	disabled,
	onRename,
	onRemove,
}: {
	tag: Tag;
	disabled: boolean;
	onRename: (name: string) => void;
	onRemove: () => void;
}) {
	const [editing, setEditing] = useState(false);
	// `draft` seeds once at mount and is intentionally NOT re-synced to `tag.name`
	// on prop change: the open-rename handler re-seeds it before every edit
	// session, and pills are keyed by `tag.id`, so a re-rendered pill is always the
	// same tag whose name only changed via the user's own just-committed edit (with
	// edit mode already closed). A merge-rename deletes THIS row (new id mounts),
	// never showing a stale draft. So no `useEffect` re-sync is needed.
	const [draft, setDraft] = useState(tag.name);
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus the rename input when it opens — programmatic focus in response to a
	// user action (clicking the pill), the a11y-safe alternative to `autoFocus`.
	useEffect(() => {
		if (editing) inputRef.current?.focus();
	}, [editing]);

	// User-edited vs LLM-proposed: sky tint (matches the "ręcznie" classification
	// indicator's color language) vs neutral.
	const tone = tag.isUserEdited
		? "bg-sky-500/15 text-sky-200 ring-sky-400/30"
		: "bg-white/10 text-white/70 ring-white/15";

	if (editing) {
		const preview = normalizeTag(draft);
		return (
			<form
				className="flex items-center gap-1"
				onSubmit={(e) => {
					e.preventDefault();
					if (preview === null) return;
					setEditing(false);
					// Skip a no-op rename (same canonical name) — leaving a tag as-is is
					// acceptance, not an edit.
					if (preview !== tag.name) onRename(draft);
				}}
			>
				<input
					aria-label="Nazwa tagu"
					className="w-32 rounded-full bg-white/10 px-2 py-0.5 text-white text-xs outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7]"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setEditing(false);
							setDraft(tag.name);
						}
					}}
					ref={inputRef}
					value={draft}
				/>
				<button
					aria-label="Zapisz nazwę tagu"
					className="rounded-full px-1.5 py-0.5 text-emerald-200 text-xs ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/15 disabled:opacity-40"
					disabled={preview === null || disabled}
					type="submit"
				>
					✓
				</button>
				<button
					aria-label="Anuluj"
					className="rounded-full px-1.5 py-0.5 text-white/60 text-xs ring-1 ring-white/15 transition hover:bg-white/10"
					onClick={() => {
						setEditing(false);
						setDraft(tag.name);
					}}
					type="button"
				>
					✕
				</button>
			</form>
		);
	}

	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ${tone}`}
		>
			<button
				className="font-medium disabled:cursor-not-allowed"
				disabled={disabled}
				onClick={() => {
					setDraft(tag.name);
					setEditing(true);
				}}
				title="Zmień nazwę"
				type="button"
			>
				{tag.name}
			</button>
			{tag.isUserEdited ? (
				<span
					aria-hidden="true"
					className="text-sky-300/70"
					title="Edytowany ręcznie"
				>
					●
				</span>
			) : null}
			<button
				aria-label={`Usuń tag ${tag.name}`}
				className="text-white/40 transition hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
				disabled={disabled}
				onClick={onRemove}
				type="button"
			>
				×
			</button>
		</span>
	);
}

// Add-tag input. `normalizeTag` previews the canonical form so the button is
// disabled when the input would normalize to nothing (mirrors the server's
// null → BAD_REQUEST guard, surfaced as a disabled control rather than an error).
function AddTagForm({
	disabled,
	onAdd,
}: {
	disabled: boolean;
	onAdd: (name: string) => void;
}) {
	const inputId = useId();
	const [value, setValue] = useState("");
	const preview = normalizeTag(value);

	return (
		<form
			className="flex items-center gap-2 border-white/10 border-t pt-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (preview === null) return;
				onAdd(value);
				setValue("");
			}}
		>
			<label className="sr-only" htmlFor={inputId}>
				Nowy tag
			</label>
			<input
				className="w-48 rounded-md bg-white/10 px-3 py-1.5 text-sm text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
				disabled={disabled}
				id={inputId}
				onChange={(e) => setValue(e.target.value)}
				placeholder="Dodaj tag…"
				value={value}
			/>
			{/* Live canonical-form preview when it differs from the raw input. */}
			{preview !== null && preview !== value.trim().toLowerCase() ? (
				<span className="text-white/40 text-xs">→ {preview}</span>
			) : null}
			<button
				className="rounded-md bg-[#a855f7] px-3 py-1.5 font-semibold text-sm text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
				disabled={disabled || preview === null}
				type="submit"
			>
				Dodaj
			</button>
		</form>
	);
}

function OverrideForm({
	conversationId,
	currentCategory,
	currentProjectId,
}: {
	conversationId: string;
	currentCategory: Category | null;
	currentProjectId: string | null;
}) {
	const utils = api.useUtils();
	const projectsQuery = api.projects.list.useQuery();

	const categoryId = useId();
	const projectFieldId = useId();
	// Default the category select to the current value, or `praca` when unassigned
	// (a category is required to submit — there is no "Nieprzypisana" category).
	const [category, setCategory] = useState<Category>(
		currentCategory ?? "praca",
	);
	// "" sentinel = no project (Nieprzypisana); mapped to null on submit.
	const [project, setProject] = useState<string>(currentProjectId ?? "");
	const [error, setError] = useState<string | null>(null);

	const override = api.conversations.overrideClassification.useMutation({
		onSuccess: async () => {
			setError(null);
			// Refresh both the detail (this page) and the list (the row badge).
			await Promise.all([
				utils.conversations.getById.invalidate({ id: conversationId }),
				utils.conversations.list.invalidate(),
			]);
		},
		// Surfaces the server BAD_REQUEST (category∈project) / NOT_FOUND message.
		onError: (err) => setError(err.message),
	});

	const allProjects = projectsQuery.data ?? [];
	// Only projects in the chosen category are selectable — enforces the
	// category∈project rule in the UI (the server re-validates regardless).
	const eligible = allProjects.filter((p) => p.category === category);

	function onCategoryChange(next: Category) {
		setCategory(next);
		// Drop a now-ineligible project so we never submit a cross-category pair.
		if (
			project &&
			!allProjects.some((p) => p.id === project && p.category === next)
		) {
			setProject("");
		}
	}

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		override.mutate({
			conversationId,
			category,
			projectId: project === "" ? null : project,
		});
	}

	const pending = override.isPending;

	return (
		<form
			className="flex flex-col gap-4 border-white/10 border-t pt-4"
			onSubmit={onSubmit}
		>
			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}

			<div className="flex flex-col gap-4 sm:flex-row sm:items-end">
				<div className="flex flex-col gap-2">
					<label
						className="font-medium text-sm text-white/80"
						htmlFor={categoryId}
					>
						Kategoria
					</label>
					<select
						className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
						disabled={pending}
						id={categoryId}
						onChange={(e) => onCategoryChange(e.target.value as Category)}
						value={category}
					>
						{CATEGORIES.map((c) => (
							<option className="text-black" key={c} value={c}>
								{CATEGORY_LABEL[c]}
							</option>
						))}
					</select>
				</div>

				<div className="flex flex-1 flex-col gap-2">
					<label
						className="font-medium text-sm text-white/80"
						htmlFor={projectFieldId}
					>
						Projekt
					</label>
					<select
						className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
						disabled={pending}
						id={projectFieldId}
						onChange={(e) => setProject(e.target.value)}
						value={project}
					>
						<option className="text-black" value="">
							Nieprzypisana
						</option>
						{eligible.map((p) => (
							<option className="text-black" key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</div>

				<button
					className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
					disabled={pending}
					type="submit"
				>
					{pending ? "Zapisywanie…" : "Zapisz"}
				</button>
			</div>
		</form>
	);
}

// The value of the "new contact" option. Not a valid contact id (ids are UUIDs
// or seeded `ct-…`), and never sent to the server — it only reveals the name
// field.
const NEW_CONTACT = "__new__";

// FR-025: who the conversation was with, and — for a Polish number no contact
// holds yet — naming it. The number never travels from here to the server:
// `labelCounterparty` reads it off the conversation row itself.
function CounterpartySection({
	conversationId,
	counterparty,
}: {
	conversationId: string;
	counterparty: NonNullable<Detail["counterparty"]>;
}) {
	const label = counterpartyLabel(counterparty);
	if (label === null) return null;
	// A known number that is neither labelled nor labelable is a foreign one:
	// the contact book only holds Polish numbers (decision #3).
	const foreign =
		counterparty.state === "known" &&
		counterparty.contactName === null &&
		!counterparty.labelable;

	return (
		<section className="flex flex-col gap-3 rounded-lg bg-white/5 p-4 ring-1 ring-white/10">
			<h2 className="font-semibold text-sm text-white/90">Rozmówca</h2>
			<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
				<span
					className={`break-all ${
						label.source === "state"
							? "text-white/40 italic"
							: label.source === "number"
								? "text-lg text-white/90 tabular-nums"
								: "font-medium text-lg text-white/90"
					}`}
				>
					{label.primary}
				</span>
				{label.source === "operator" ? (
					<span
						className="rounded-full bg-white/10 px-2 py-0.5 text-white/60 text-xs"
						title="Nazwa podana przez operatora telefonii — nie jest Twoim kontaktem"
					>
						podpowiedź od operatora
					</span>
				) : null}
				{label.secondary ? (
					<span className="text-sm text-white/50 tabular-nums">
						{label.secondary}
					</span>
				) : null}
			</div>
			{foreign ? (
				<p className="text-white/40 text-xs">
					Książka kontaktów przyjmuje tylko numery polskie — tego numeru nie
					można nazwać.
				</p>
			) : null}
			{counterparty.labelable ? (
				<LabelCounterpartyForm
					conversationId={conversationId}
					nameHint={counterparty.nameHint}
				/>
			) : null}
		</section>
	);
}

function LabelCounterpartyForm({
	conversationId,
	nameHint,
}: {
	conversationId: string;
	nameHint: string | null;
}) {
	const utils = api.useUtils();
	const contactsQuery = api.contacts.list.useQuery();
	const pickerId = useId();
	const nameId = useId();
	// Only contacts WITHOUT a number: the conversation view writes a number onto
	// a contact, it never overwrites one (`contacts.update` is the place for that).
	const numberless = sortByPolishName(
		(contactsQuery.data ?? []).filter((c) => c.e164 === null),
	);
	const [target, setTarget] = useState<string>(NEW_CONTACT);
	// What the form actually submits: a picked contact that has since left
	// `numberless` (deleted, or numbered in another tab) falls back to "new",
	// so the select, the name field and the payload never disagree.
	const choice = numberless.some((c) => c.id === target) ? target : NEW_CONTACT;
	// Pre-filled with the operator's name — a starting point the user edits,
	// never saved without them pressing the button.
	const [name, setName] = useState(nameHint ?? "");
	const [error, setError] = useState<string | null>(null);

	const label = api.conversations.labelCounterparty.useMutation({
		onSuccess: async () => {
			setError(null);
			// The label is derived by joining on the number, so every view that
			// shows a contact name or a number's owner is now stale — including
			// the detail of every OTHER conversation with this number, which now
			// carries the name and is no longer labelable.
			await Promise.all([
				utils.conversations.getById.invalidate(),
				utils.conversations.list.invalidate(),
				utils.contacts.list.invalidate(),
				utils.calls.history.invalidate(),
			]);
		},
		// CONFLICT names the contact already holding the number; BAD_REQUEST
		// covers a contact that gained a number meanwhile.
		onError: (err) => setError(err.message),
	});

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		if (choice === NEW_CONTACT) {
			const parsed = createContactInput.shape.name.safeParse(name);
			if (!parsed.success) {
				setError("Nazwa musi mieć od 1 do 60 znaków.");
				return;
			}
			label.mutate({
				conversationId,
				target: { kind: "new", name: parsed.data },
			});
		} else {
			label.mutate({
				conversationId,
				target: { kind: "existing", contactId: choice },
			});
		}
	}

	const pending = label.isPending;

	return (
		<form
			className="flex flex-col gap-3 border-white/10 border-t pt-3"
			onSubmit={onSubmit}
		>
			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
				<div className="flex flex-col gap-2">
					<label
						className="font-medium text-sm text-white/80"
						htmlFor={pickerId}
					>
						Nazwij numer
					</label>
					<select
						className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
						disabled={pending}
						id={pickerId}
						onChange={(e) => setTarget(e.target.value)}
						value={choice}
					>
						<option className="text-black" value={NEW_CONTACT}>
							Nowy kontakt…
						</option>
						{numberless.map((c) => (
							<option className="text-black" key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</div>
				{choice === NEW_CONTACT ? (
					<div className="flex flex-1 flex-col gap-2">
						<label
							className="font-medium text-sm text-white/80"
							htmlFor={nameId}
						>
							Nazwa kontaktu
						</label>
						<input
							autoComplete="off"
							className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
							disabled={pending}
							id={nameId}
							maxLength={60}
							onChange={(e) => setName(e.target.value)}
							value={name}
						/>
					</div>
				) : null}
				<button
					className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
					disabled={pending}
					type="submit"
				>
					{pending ? "Zapisywanie…" : "Zapisz"}
				</button>
			</div>
		</form>
	);
}
