"use client";

/**
 * Global tag merge (`tag-vocabulary-control`, phase 4).
 *
 * Lives next to the EXPANDED tag cloud, because that is the only place the
 * counts are all on screen — merging is a decision you make by comparing
 * `faktury 4` with `faktura 3`, and the collapsed cloud deliberately hides the
 * long tail the variants live in.
 *
 * Its own component rather than more state inside `conversations-view`: the
 * view already carries four filters, a debounce and the cloud rule, and this
 * adds a second, DESTRUCTIVE mode of interaction to the same names. The plan
 * allows either shape; the split keeps the irreversible path visually and
 * structurally separate from the read-only filters.
 *
 * The confirmation is not decoration — `tags.mergeGlobal` deletes rows and no
 * image rollback brings them back — so it names both tags, the number of
 * conversations it will touch, and says "nieodwracalna" before the mutation
 * can fire.
 */

import { useId, useState } from "react";

import { api } from "~/trpc/react";

import type { CloudTag } from "../_lib/tag-cloud";

/**
 * Polish plural for "rozmowa" — 1 / 2–4 / 5+, with the teens exception (12–14
 * take the many-form despite ending in 2–4, so `22 → rozmowy` but
 * `112 → rozmów`).
 *
 * Two cases, because Polish inflects after a preposition and the two call sites
 * govern differently: "Dotknie to 3 rozmowy" is accusative, while "w 3
 * rozmowach" after `w` is locative. One shared helper returning only the
 * accusative produced "…w 4 rozmowy" in the success line (impl-review phase 4,
 * F3).
 */
function conversationsLabel(
	n: number,
	grammaticalCase: "accusative" | "locative",
): string {
	const lastTwo = n % 100;
	const last = n % 10;
	const few = last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14);
	if (grammaticalCase === "locative") {
		if (n === 1) return "1 rozmowie";
		return `${n} rozmowach`;
	}
	if (n === 1) return "1 rozmowę";
	return `${n} ${few ? "rozmowy" : "rozmów"}`;
}

export function TagMergePanel({
	tags,
	onMerged,
}: {
	/** The full ranked list — merging is about the tail, so NOT the capped cloud. */
	tags: readonly CloudTag[];
	/** Called after a successful merge so the view can re-point any selection. */
	onMerged: (from: string, to: string) => void;
}) {
	const fromId = useId();
	const toId = useId();
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	const utils = api.useUtils();
	const mergeMut = api.tags.mergeGlobal.useMutation({
		onSuccess: async (res) => {
			setConfirming(false);
			setDone(
				res.conversations === 0
					? `Tag „${from}” nie był już używany — nic nie zmieniono.`
					: `Scalono „${from}” w „${to}” w ${conversationsLabel(res.conversations, "locative")}.`,
			);
			onMerged(from, to);
			setFrom("");
			setTo("");
			// The whole `conversations` router, not just `list`: a merge moves
			// counts in the chips, changes which conversations an active tag
			// filter matches, AND rewrites the tag set of every detail page. A
			// `.list`-only invalidation left `getById` serving cached chips whose
			// `tagId`s no longer exist for `staleTime` (30 s), so "usuń" answered
			// NOT_FOUND for a tag visibly on screen (impl-review phase 4, F4).
			await Promise.all([
				utils.tags.listWithCounts.invalidate(),
				utils.conversations.invalidate(),
			]);
		},
		onError: (err) => {
			setConfirming(false);
			setError(err.message);
		},
	});

	// Two distinct names are required; the server rejects `from === to` after
	// normalization, this only keeps the button from offering it.
	const ready = from !== "" && to !== "" && from !== to;
	const affected = tags.find((t) => t.name === from)?.count ?? 0;

	// Any change to either side retracts an open confirmation and clears the
	// previous outcome — a confirmation must never outlive the pair it names.
	function reset(next: () => void) {
		setError(null);
		setDone(null);
		setConfirming(false);
		next();
	}

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-white/5 p-3 ring-1 ring-white/10">
			<p className="font-medium text-white/70 text-xs">
				Scal warianty tego samego tagu
			</p>
			<div className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<label className="text-white/50 text-xs" htmlFor={fromId}>
						Scal tag
					</label>
					<select
						className="rounded-lg bg-white/5 px-2 py-1.5 text-sm text-white/80 ring-1 ring-white/15 transition focus:text-white focus:ring-[#a855f7]"
						id={fromId}
						onChange={(e) => reset(() => setFrom(e.target.value))}
						value={from}
					>
						<option value="">—</option>
						{tags.map((t) => (
							<option key={t.name} value={t.name}>
								{t.name} ({t.count})
							</option>
						))}
					</select>
				</div>
				<div className="flex flex-col gap-1">
					<label className="text-white/50 text-xs" htmlFor={toId}>
						w tag
					</label>
					<select
						className="rounded-lg bg-white/5 px-2 py-1.5 text-sm text-white/80 ring-1 ring-white/15 transition focus:text-white focus:ring-[#a855f7]"
						id={toId}
						onChange={(e) => reset(() => setTo(e.target.value))}
						value={to}
					>
						<option value="">—</option>
						{/* The source is excluded so the self-merge the server rejects
						    cannot even be picked. */}
						{tags
							.filter((t) => t.name !== from)
							.map((t) => (
								<option key={t.name} value={t.name}>
									{t.name} ({t.count})
								</option>
							))}
					</select>
				</div>
				{confirming ? null : (
					<button
						className="rounded-md bg-white/10 px-3 py-1.5 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 hover:text-white disabled:opacity-40"
						disabled={!ready || mergeMut.isPending}
						onClick={() => {
							setError(null);
							setDone(null);
							setConfirming(true);
						}}
						type="button"
					>
						Scal…
					</button>
				)}
			</div>

			{confirming && ready ? (
				<div
					className="flex flex-col gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-100 text-sm ring-1 ring-amber-400/30"
					role="alert"
				>
					<p>
						Scalić „{from}” w „{to}”? Dotknie to{" "}
						{conversationsLabel(affected, "accusative")}. Tag „{from}”
						przestanie istnieć.
					</p>
					<p className="font-medium">
						Operacja jest nieodwracalna — cofnięcie wymaga przywrócenia kopii
						bazy.
					</p>
					<div className="flex gap-2">
						<button
							className="rounded-md bg-amber-400/20 px-3 py-1.5 font-medium text-amber-50 text-sm ring-1 ring-amber-300/40 transition hover:bg-amber-400/30 disabled:opacity-40"
							disabled={mergeMut.isPending}
							onClick={() => mergeMut.mutate({ from, to })}
							type="button"
						>
							{mergeMut.isPending ? "Scalanie…" : "Potwierdź scalanie"}
						</button>
						<button
							className="rounded-md px-3 py-1.5 font-medium text-amber-100/80 text-sm underline-offset-2 transition hover:text-amber-50 hover:underline"
							disabled={mergeMut.isPending}
							onClick={() => setConfirming(false)}
							type="button"
						>
							Anuluj
						</button>
					</div>
				</div>
			) : null}

			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-xs"
					role="alert"
				>
					Nie udało się scalić tagów: {error}
				</p>
			) : null}
			{done ? (
				<p className="text-emerald-200/80 text-xs" role="status">
					{done}
				</p>
			) : null}
		</div>
	);
}
