"use client";

import { type FormEvent, useId, useState } from "react";

import { categorySchema } from "~/server/llm/schemas";
import { createProjectInput } from "~/server/projects/schema";
import { api, type RouterOutputs } from "~/trpc/react";

type Category = "praca" | "prywatne";
type Project = RouterOutputs["projects"]["list"][number];

const CATEGORY_LABEL: Record<Category, string> = {
	praca: "Praca",
	prywatne: "Prywatne",
};

// Both groups render in a fixed order even when empty (FR-014: praca, prywatne).
const CATEGORIES = categorySchema.options;

// Polish plural for "rozmowa": 1 → rozmowa; 2–4 (excl. the 12–14 teens) →
// rozmowy; everything else (0, 5+) → rozmów. A flat "(N rozmów)" would read as
// broken Polish for N=1 in a Polish-only product.
function rozmowyLabel(n: number): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (n === 1) return "rozmowa";
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
		return "rozmowy";
	return "rozmów";
}

export function ProjectsView() {
	const utils = api.useUtils();
	const list = api.projects.list.useQuery();

	const nameId = useId();
	const categoryId = useId();
	const [name, setName] = useState("");
	const [category, setCategory] = useState<Category>("praca");
	const [error, setError] = useState<string | null>(null);

	const create = api.projects.create.useMutation({
		onSuccess: async () => {
			setName("");
			setError(null);
			await utils.projects.list.invalidate();
		},
		// Surfaces the server CONFLICT message ("A project with this name already
		// exists in this category") and any other server-side rejection.
		onError: (err) => setError(err.message),
	});

	const del = api.projects.delete.useMutation({
		onSuccess: async () => {
			await utils.projects.list.invalidate();
		},
		onError: (err) => setError(err.message),
	});

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		// Client pre-validation against the SAME schema the server enforces — trims
		// before the length check, so a 61-char name is blocked here without a round
		// trip. The server re-validates regardless.
		const parsed = createProjectInput.safeParse({ name, category });
		if (!parsed.success) {
			setError(
				parsed.error.issues[0]?.message ?? "Nieprawidłowa nazwa projektu.",
			);
			return;
		}
		create.mutate(parsed.data);
	}

	function onDelete(project: Project) {
		// window.confirm is acceptable for the MVP (single-user, page-load model).
		// HARD cascade (project-delete-cascade): deleting a project permanently
		// removes its assigned conversations too — warn about the irreversible loss.
		if (
			!window.confirm(
				`Usunąć projekt „${project.name}” i wszystkie powiązane rozmowy? Tej operacji nie można cofnąć.`,
			)
		) {
			return;
		}
		del.mutate({ id: project.id });
	}

	const pending = create.isPending;
	const projects = list.data ?? [];

	return (
		<div className="flex flex-col gap-8">
			<h1 className="font-bold text-2xl tracking-tight">Projekty</h1>

			<form
				className="flex flex-col gap-4 rounded-lg bg-white/5 p-4 ring-1 ring-white/10"
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
					<div className="flex flex-1 flex-col gap-2">
						<label
							className="font-medium text-sm text-white/80"
							htmlFor={nameId}
						>
							Nazwa projektu
						</label>
						<input
							className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
							disabled={pending}
							id={nameId}
							maxLength={60}
							onChange={(e) => setName(e.target.value)}
							required
							value={name}
						/>
					</div>

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
							onChange={(e) => setCategory(e.target.value as Category)}
							value={category}
						>
							{CATEGORIES.map((c) => (
								<option className="text-black" key={c} value={c}>
									{CATEGORY_LABEL[c]}
								</option>
							))}
						</select>
					</div>

					<button
						className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
						disabled={pending}
						type="submit"
					>
						{pending ? "Dodawanie…" : "Dodaj projekt"}
					</button>
				</div>
			</form>

			{list.isPending ? (
				<p className="text-white/60">Ładowanie…</p>
			) : list.isError ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200"
					role="alert"
				>
					Nie udało się wczytać projektów.
				</p>
			) : (
				<div className="flex flex-col gap-8">
					{CATEGORIES.map((c) => (
						<CategoryGroup
							category={c}
							deletingId={del.isPending ? del.variables?.id : undefined}
							key={c}
							onDelete={onDelete}
							projects={projects.filter((p) => p.category === c)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function CategoryGroup({
	category,
	projects,
	onDelete,
	deletingId,
}: {
	category: Category;
	projects: Project[];
	onDelete: (project: Project) => void;
	deletingId: string | undefined;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="font-semibold text-lg text-white/90">
				{CATEGORY_LABEL[category]}
			</h2>
			{projects.length === 0 ? (
				<p className="text-sm text-white/40 italic">Brak projektów.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{projects.map((project) => (
						<li
							className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-4 py-3 ring-1 ring-white/10"
							key={project.id}
						>
							<span className="text-sm text-white/90">
								{project.name}{" "}
								<span className="text-white/50">
									({project.conversationCount}{" "}
									{rozmowyLabel(project.conversationCount)})
								</span>
							</span>
							<button
								className="rounded-md px-3 py-1.5 font-medium text-red-200 text-sm ring-1 ring-red-400/30 transition hover:bg-red-500/15 disabled:opacity-50"
								disabled={deletingId === project.id}
								onClick={() => onDelete(project)}
								type="button"
							>
								{deletingId === project.id ? "Usuwanie…" : "Usuń"}
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
