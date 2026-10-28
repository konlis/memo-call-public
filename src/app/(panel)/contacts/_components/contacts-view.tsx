"use client";

import { type FormEvent, useId, useState } from "react";
import { sortByPolishName } from "~/app/(panel)/_lib/contact-order";
import { formatForDisplay } from "~/app/(panel)/_lib/phone-display";
import {
	createContactInput,
	updateContactInput,
} from "~/server/contacts/schema";
import { normalizePolishE164 } from "~/server/telephony/phone";
import { api, type RouterOutputs } from "~/trpc/react";

type Contact = RouterOutputs["contacts"]["list"][number];

const NUMBER_HINT =
	"Podaj poprawny numer telefonu (np. 600 100 200 lub +48600100200).";

/**
 * Contact-book management screen (`contact-directory` phase 2). Add a contact
 * (name + OPTIONAL number), rename it, clear or change its number, delete it.
 * Modelled 1:1 on `projects-view.tsx`: no UI library, `window.confirm` for
 * destructive actions, no optimistic updates — every mutation invalidates
 * `contacts.list` and re-reads.
 *
 * ⚠️ AN EMPTIED NUMBER FIELD SENDS AN EXPLICIT `null`, NEVER `""`. `e164` on
 * `updateContactInput` is `.nullable()`, so `null` is the "clear it" intent
 * while `""` fails `.min(1)` and would surface as `BAD_REQUEST` instead of
 * clearing the number. Note `.nullable()` leaves the KEY REQUIRED — there is no
 * "leave it alone" state — which is why the edit form always submits BOTH
 * fields, prefilled from the current row.
 */
export function ContactsView() {
	const utils = api.useUtils();
	const list = api.contacts.list.useQuery();

	const nameId = useId();
	const numberId = useId();
	const [name, setName] = useState("");
	const [number, setNumber] = useState("");
	// Two error surfaces, deliberately. `error` belongs to the add form (and to
	// delete, whose only realistic failure is a NOT_FOUND on an already-gone
	// row); `editError` renders INSIDE the row being edited. With one shared
	// banner at the top of the page, a CONFLICT raised while editing row 20
	// paints off-screen, and the failure is indistinguishable from "nothing
	// happened" — the button just returns to "Zapisz" (impl-review phase 2, F1).
	const [error, setError] = useState<string | null>(null);
	const [editError, setEditError] = useState<string | null>(null);

	// One row at a time is editable; the drafts live here rather than in the row
	// so that opening a second editor discards the first cleanly — which is why
	// the "Edytuj" buttons are NOT disabled while an edit is open. Disabling
	// them made that sentence false, and wedged the entire page when the edited
	// row vanished from a background refetch: the edit form (and with it the
	// only "Anuluj") stopped rendering while every "Edytuj" stayed disabled
	// (impl-review phase 2, F2).
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editNumber, setEditNumber] = useState("");

	// Every contact mutation also invalidates `calls.history`: since
	// `contact-directory` phase 3 the `/call` picker renders the CONTACT NAME for
	// a number it recognizes, so its cached rows carry data this screen has just
	// changed. Without this, deleting or renaming a contact leaves the pill
	// showing the stale name for `staleTime` (30 s, `query-client.ts:13`) after
	// navigating back — the two queries live in one client that survives
	// client-side navigation. Since FR-025 the same holds for the conversation
	// list and detail: they derive the counterparty's NAME by joining on the
	// number, so renaming, renumbering or deleting a contact changes what they
	// show.
	async function invalidateContactViews() {
		await Promise.all([
			utils.contacts.list.invalidate(),
			utils.calls.history.invalidate(),
			utils.conversations.list.invalidate(),
			utils.conversations.getById.invalidate(),
		]);
	}

	const create = api.contacts.create.useMutation({
		onSuccess: async () => {
			setName("");
			setNumber("");
			setError(null);
			await invalidateContactViews();
		},
		// Surfaces the server CONFLICT message, which names the colliding contact
		// ("Ten numer należy już do kontaktu „…”"), plus any other rejection.
		onError: (err) => setError(err.message),
	});

	const update = api.contacts.update.useMutation({
		onSuccess: async () => {
			setEditingId(null);
			setEditError(null);
			await invalidateContactViews();
		},
		// Into the row's own banner, not the page-top one — the user is looking
		// at the row they just tried to save.
		onError: (err) => setEditError(err.message),
	});

	const del = api.contacts.delete.useMutation({
		onSuccess: async () => {
			await invalidateContactViews();
		},
		onError: (err) => setError(err.message),
	});

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);

		// An empty number field means "a contact with no number" — omit the key
		// entirely, because `createContactInput.e164` is `.optional()` and `""`
		// would fail `.min(1)`.
		const trimmed = number.trim();
		const parsed = createContactInput.safeParse(
			trimmed === "" ? { name } : { e164: trimmed, name },
		);
		if (!parsed.success) {
			setError(
				parsed.error.issues[0]?.message ?? "Nieprawidłowe dane kontaktu.",
			);
			return;
		}
		// Same rule the server applies (`normalizePolishE164`), run client-side only
		// for a faster, more specific message than the server's BAD_REQUEST. The
		// server remains authoritative.
		if (
			parsed.data.e164 !== undefined &&
			normalizePolishE164(parsed.data.e164) === null
		) {
			setError(NUMBER_HINT);
			return;
		}
		create.mutate(parsed.data);
	}

	function onEdit(contact: Contact) {
		setError(null);
		setEditError(null);
		setEditingId(contact.id);
		setEditName(contact.name);
		// Formatted, not raw (full-plan impl-review, F9): the row shows
		// `+48 600 100 200`, so seeding the field with `+48600100200` made the
		// value visibly change shape the instant "Edytuj" was clicked, as though
		// the click had edited something. Harmless either way —
		// `normalizePolishE164` accepts both — and safe for a contact with no
		// number, since `formatForDisplay("") === ""`.
		setEditNumber(formatForDisplay(contact.e164 ?? ""));
	}

	// Leaving the editor drops its error with it — otherwise the banner outlives
	// the operation it describes (impl-review phase 2, F3).
	function onEditCancel() {
		setEditingId(null);
		setEditError(null);
	}

	function onEditSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (editingId === null) return;
		setEditError(null);

		// The load-bearing line: an emptied field becomes `null` (clear the
		// number), never `""`.
		const trimmed = editNumber.trim();
		const parsed = updateContactInput.safeParse({
			e164: trimmed === "" ? null : trimmed,
			id: editingId,
			name: editName,
		});
		if (!parsed.success) {
			setEditError(
				parsed.error.issues[0]?.message ?? "Nieprawidłowe dane kontaktu.",
			);
			return;
		}
		if (
			parsed.data.e164 !== null &&
			normalizePolishE164(parsed.data.e164) === null
		) {
			setEditError(NUMBER_HINT);
			return;
		}
		update.mutate(parsed.data);
	}

	function onDelete(contact: Contact) {
		// window.confirm is acceptable for the MVP (single-user, page-load model),
		// matching `projects-view.tsx`. Deleting a contact touches nothing else —
		// the dialing history in `/call` keeps its number either way.
		//
		// Which is precisely why the prompt SAYS SO when there is a number
		// (full-plan impl-review, F5). Someone deleting "Marek" in order to get
		// his number out of MemoCall would otherwise meet that number again on
		// `/call`, never having been told these are two separate deletions.
		// `projects-view.tsx:82` sets the precedent: state the consequence inside
		// the prompt, not only in a comment the user never reads.
		const consequence =
			contact.e164 === null
				? ""
				: `\n\nNumer ${formatForDisplay(contact.e164)} zostanie na liście ostatnio wybieranych w „Zadzwoń” — usuń go tam osobno, jeśli ma zniknąć.`;
		if (!window.confirm(`Usunąć kontakt „${contact.name}”?${consequence}`)) {
			return;
		}
		setError(null);
		del.mutate({ id: contact.id });
	}

	const pending = create.isPending;
	// Polish order, not the server's BINARY `ORDER BY name` — see
	// `contact-order.ts`. The `/call` select sorts through the same module so
	// the two screens cannot disagree about "alphabetical".
	const contacts = sortByPolishName(list.data ?? []);

	return (
		<div className="flex flex-col gap-8">
			<h1 className="font-bold text-2xl tracking-tight">Kontakty</h1>

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
							Nazwa kontaktu
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

					<div className="flex flex-1 flex-col gap-2">
						<label
							className="font-medium text-sm text-white/80"
							htmlFor={numberId}
						>
							Numer (opcjonalny)
						</label>
						<input
							autoComplete="tel"
							className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
							disabled={pending}
							id={numberId}
							inputMode="tel"
							onChange={(e) => setNumber(e.target.value)}
							placeholder="600 100 200"
							type="tel"
							value={number}
						/>
					</div>

					<button
						className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
						disabled={pending}
						type="submit"
					>
						{pending ? "Dodawanie…" : "Dodaj kontakt"}
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
					Nie udało się wczytać kontaktów.
				</p>
			) : contacts.length === 0 ? (
				<p className="text-sm text-white/40 italic">Brak kontaktów.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{contacts.map((contact) =>
						contact.id === editingId ? (
							<li
								className="rounded-lg bg-white/5 px-4 py-3 ring-1 ring-white/10"
								key={contact.id}
							>
								<form className="flex flex-col gap-3" onSubmit={onEditSubmit}>
									{editError ? (
										<p
											className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
											role="alert"
										>
											{editError}
										</p>
									) : null}
									<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
										<input
											aria-label="Nazwa kontaktu"
											className="flex-1 rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
											disabled={update.isPending}
											maxLength={60}
											onChange={(e) => setEditName(e.target.value)}
											required
											value={editName}
										/>
										<input
											aria-label="Numer (opcjonalny)"
											autoComplete="tel"
											className="flex-1 rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
											disabled={update.isPending}
											inputMode="tel"
											onChange={(e) => setEditNumber(e.target.value)}
											placeholder="600 100 200"
											type="tel"
											value={editNumber}
										/>
										<span className="flex items-center gap-2">
											<button
												className="rounded-md bg-[#a855f7] px-3 py-1.5 font-semibold text-sm text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
												disabled={update.isPending}
												type="submit"
											>
												{update.isPending ? "Zapisywanie…" : "Zapisz"}
											</button>
											<button
												className="rounded-md px-3 py-1.5 font-medium text-sm text-white/70 ring-1 ring-white/20 transition hover:bg-white/10 disabled:opacity-50"
												disabled={update.isPending}
												onClick={onEditCancel}
												type="button"
											>
												Anuluj
											</button>
										</span>
									</div>
								</form>
							</li>
						) : (
							<li
								className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-4 py-3 ring-1 ring-white/10"
								key={contact.id}
							>
								<span className="flex flex-col gap-0.5">
									<span className="text-sm text-white/90">{contact.name}</span>
									{contact.e164 ? (
										<span className="text-sm text-white/50">
											{formatForDisplay(contact.e164)}
										</span>
									) : (
										<span className="text-sm text-white/40 italic">
											Bez numeru
										</span>
									)}
								</span>
								<span className="flex items-center gap-2">
									<button
										className="rounded-md px-3 py-1.5 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/10 disabled:opacity-50"
										onClick={() => onEdit(contact)}
										type="button"
									>
										Edytuj
									</button>
									<button
										className="rounded-md px-3 py-1.5 font-medium text-red-200 text-sm ring-1 ring-red-400/30 transition hover:bg-red-500/15 disabled:opacity-50"
										disabled={del.isPending && del.variables?.id === contact.id}
										onClick={() => onDelete(contact)}
										type="button"
									>
										{del.isPending && del.variables?.id === contact.id
											? "Usuwanie…"
											: "Usuń"}
									</button>
								</span>
							</li>
						),
					)}
				</ul>
			)}
		</div>
	);
}
