"use client";

import { type FormEvent, useId, useState } from "react";

import { sortByPolishName } from "~/app/(panel)/_lib/contact-order";
import { formatForDisplay } from "~/app/(panel)/_lib/phone-display";
import {
	ambiguousContactNames,
	pillLabel,
} from "~/app/(panel)/_lib/pill-label";
import { normalizePolishE164 } from "~/server/telephony/phone";
import { api } from "~/trpc/react";

/**
 * Fire-and-forget outbound dial form (US-01). Calls `calls.placeOutbound`; on
 * success shows "dzwonię — odbierz telefon" (no realtime/polling — honors the
 * no-streaming constraint). The recipient number is re-validated client-side
 * with the SAME `normalizePolishE164` rule the server enforces (a pure module,
 * imported the same way `projects-view` imports `~/server/.../schema`), so an
 * obviously-bad number is caught before a round trip — but the server is always
 * authoritative.
 *
 * Also renders the dialing history (`calls.history`) as a picker above the
 * input: clicking an entry fills the field but does NOT dial, so a mis-click
 * cannot place a call. Each entry can be removed — dialing history is one of
 * the places MemoCall stores a phone number (with the contact book and, since
 * FR-025, the conversation's counterparty), so forgetting one has to be
 * reachable from the same screen.
 *
 * Since `contact-directory` phase 3 a pill shows the CONTACT NAME when the
 * number is signed, and the raw number when it is not. The removal button's
 * `aria-label` is built from that same label on purpose: a screen reader must
 * not read out a number the screen is not showing.
 *
 * The "Kontakt" select above the number field closes the gap the history alone
 * leaves — a contact never dialled before has no pill, and without the select
 * its number would have to be copied over from `/contacts` by hand. It offers
 * only contacts that HAVE a number (one without a number is not dialable)
 * and, like a pill, only fills the field. Its own value is DERIVED from `to`
 * rather than kept in state, so typing a signed number by hand selects the
 * contact and editing one character deselects it, with nothing to keep in sync.
 */
export function CallForm() {
	const numberId = useId();
	const contactId = useId();
	const [to, setTo] = useState("");
	const [hint, setHint] = useState<string | null>(null);

	const utils = api.useUtils();
	const history = api.calls.history.useQuery();
	const contacts = api.contacts.list.useQuery();

	// Only a contact with a number can be dialled. Re-sorted on the client
	// because the server's `ORDER BY name` is SQLite's BINARY collation, which
	// is not Polish alphabetical order — see `contact-order.ts`.
	const dialableContacts = sortByPolishName(
		(contacts.data ?? []).filter(
			(c): c is typeof c & { e164: string } => c.e164 !== null,
		),
	);

	// A controlled select needs a value that is one of its options. `to` may hold
	// any typed form ("600 100 200"), so normalize before matching, and fall back
	// to the placeholder whenever the field does not hold a known contact's
	// number — including while the user is mid-edit.
	const normalizedTo = normalizePolishE164(to);
	const selectedContactNumber =
		normalizedTo !== null &&
		dialableContacts.some((c) => c.e164 === normalizedTo)
			? normalizedTo
			: "";

	const placeCall = api.calls.placeOutbound.useMutation({
		onError: () => setHint(null),
		// A placed call bumps the number's recency (or adds it), so the picker is
		// stale until refetched. The call itself is unaffected either way.
		//
		// `contacts.list` is refetched too, although `placeOutbound` cannot change
		// a contact (full-plan impl-review, F7). This screen derives "whose number
		// is this" TWICE — server-side in the history join, client-side from this
		// query for the select — and refreshing only one of them is exactly what
		// lets a pill and the select name the same person differently at the same
		// moment. A coherence refresh, NOT a data dependency: nothing here writes
		// to `contacts`.
		onSuccess: () => {
			void utils.calls.history.invalidate();
			void utils.contacts.list.invalidate();
		},
	});

	const forget = api.calls.forget.useMutation({
		onSuccess: () => void utils.calls.history.invalidate(),
	});

	function onChange(value: string) {
		setTo(value);
		setHint(null);
		// Clear a prior success/error banner once the user edits the number.
		if (placeCall.isSuccess || placeCall.isError) placeCall.reset();
	}

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setHint(null);
		// Lightweight client-side guard; the server normalizes + validates again.
		if (normalizePolishE164(to) === null) {
			setHint(
				"Podaj poprawny numer telefonu (np. 600 100 200 lub +48600100200).",
			);
			return;
		}
		placeCall.mutate({ to });
	}

	const pending = placeCall.isPending;
	const ambiguousNames = ambiguousContactNames(history.data ?? []);

	return (
		<form
			className="flex flex-col gap-4 rounded-lg bg-white/5 p-4 ring-1 ring-white/10"
			onSubmit={onSubmit}
		>
			{hint ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{hint}
				</p>
			) : null}

			{placeCall.isError ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					Nie udało się zadzwonić. Spróbuj ponownie.
				</p>
			) : null}

			{placeCall.isSuccess ? (
				<p
					className="rounded-md bg-green-500/15 px-3 py-2 text-green-200 text-sm"
					role="status"
				>
					Dzwonię — odbierz telefon. Rozmowa pojawi się na liście po
					zakończeniu.
				</p>
			) : null}

			{history.isError ? (
				// The mirror of the `contacts.isError` banner below, and the more
				// load-bearing of the two (full-plan impl-review, F2). Without it a
				// failed `calls.history` renders NOTHING, which is indistinguishable
				// from "you have never dialled anyone" — an alarming and false
				// reading, since `dialed_numbers` is one of the tables in this system
				// that hold a number. This is also the query whose failure
				// genuinely does remove every contact name from the screen, because
				// the names ride on ITS rows (the LEFT JOIN in `calls.ts`), not on
				// `contacts.list`.
				<p
					className="rounded-md bg-amber-500/15 px-3 py-2 text-amber-200 text-sm"
					role="alert"
				>
					Nie udało się wczytać listy ostatnio wybieranych — nic nie zostało
					usunięte. Wpisz numer ręcznie albo odśwież stronę.
				</p>
			) : null}

			{forget.isError ? (
				// A failed `forget` used to say nothing at all: the pill stayed put
				// and the user was left to guess (full-plan impl-review, F6). The
				// defect predates phase 3, which raised its stakes — the pill now
				// carries a PERSON'S NAME, so silence reads as "MemoCall will not
				// forget this person". Name the true outcome: the row is untouched.
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					Nie udało się usunąć numeru z listy ostatnio wybieranych — został bez
					zmian. Spróbuj ponownie.
				</p>
			) : null}

			{history.data && history.data.length > 0 ? (
				<div className="flex flex-col gap-2">
					<h2 className="font-medium text-sm text-white/60">
						Ostatnio wybierane
					</h2>
					<ul className="flex flex-wrap gap-2">
						{history.data.map((entry) => {
							// `aria-label` below reuses this exact string, so the button
							// never announces a number that is not on screen — and, since
							// F4, never announces a name that a second pill also carries.
							const label = pillLabel(
								entry.contactName,
								entry.e164,
								ambiguousNames,
							);
							return (
								<li
									className="flex items-center overflow-hidden rounded-full bg-white/10 ring-1 ring-white/15"
									key={entry.id}
								>
									{/* Fills the input only — never dials, so a mis-tap is free. */}
									<button
										className="px-3 py-1.5 text-sm text-white/90 transition hover:bg-white/10 disabled:opacity-50"
										disabled={pending}
										onClick={() => onChange(entry.e164)}
										type="button"
									>
										{label}
									</button>
									<button
										// "z listy ostatnio wybieranych", not "z historii":
										// since `label` can be a contact NAME, the short
										// wording made the only destructive control on the
										// pill sound like "delete the contact". It does not.
										aria-label={`Usuń ${label} z listy ostatnio wybieranych`}
										className="px-2 py-1.5 text-white/40 text-xs transition hover:bg-red-500/20 hover:text-red-200 disabled:opacity-50"
										disabled={forget.isPending}
										onClick={() => forget.mutate({ id: entry.id })}
										type="button"
									>
										✕
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}

			{contacts.isError ? (
				// Without this line the failure is INVISIBLE and reads as the wrong
				// diagnosis (impl-review phase 3, F4): the select simply is not
				// there, so the screen says "my contact book is gone" rather than
				// "a request failed". Inert on purpose — dialing by hand still
				// works, so this warns without blocking anything.
				//
				// ⚠️ IT SAYS NOTHING ABOUT THE PILL LABELS, AND MUST NOT (full-plan
				// impl-review, F1). A pill reads `entry.contactName`, which the
				// server LEFT JOIN in `calls.ts` puts on the `calls.history` row —
				// a different tRPC operation, unaffected by this one failing. The
				// earlier wording claimed an errored `contacts.list` "drops every
				// pill back to a bare number"; it does not, and the banner then
				// contradicted the named pill sitting right above it.
				<p
					className="rounded-md bg-amber-500/15 px-3 py-2 text-amber-200 text-sm"
					role="alert"
				>
					Nie udało się wczytać kontaktów — wybór z książki jest niedostępny.
					Dzwonienie i lista ostatnio wybieranych działają normalnie.
				</p>
			) : null}

			{dialableContacts.length > 0 ? (
				<div className="flex flex-col gap-2">
					<label
						className="font-medium text-sm text-white/80"
						htmlFor={contactId}
					>
						Kontakt
					</label>
					<select
						className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
						disabled={pending}
						id={contactId}
						onChange={(e) => {
							// Fills the field only — dialing stays an explicit submit,
							// exactly like clicking a history pill.
							if (e.target.value !== "") onChange(e.target.value);
						}}
						value={selectedContactNumber}
					>
						{/* `disabled`, not just guarded in the handler: the empty value
						    is the PLACEHOLDER state, never a choice. Selectable, it
						    would fire `onChange("")`, be swallowed above, and snap
						    straight back — a control that visibly does nothing. */}
						<option className="text-black" disabled value="">
							— wybierz z książki —
						</option>
						{dialableContacts.map((c) => (
							<option className="text-black" key={c.id} value={c.e164}>
								{c.name} · {formatForDisplay(c.e164)}
							</option>
						))}
					</select>
				</div>
			) : null}

			<div className="flex flex-col gap-4 sm:flex-row sm:items-end">
				<div className="flex flex-1 flex-col gap-2">
					<label
						className="font-medium text-sm text-white/80"
						htmlFor={numberId}
					>
						Numer rozmówcy
					</label>
					<input
						autoComplete="tel"
						className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
						disabled={pending}
						id={numberId}
						inputMode="tel"
						onChange={(e) => onChange(e.target.value)}
						placeholder="600 100 200"
						required
						type="tel"
						value={to}
					/>
				</div>

				<button
					className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
					disabled={pending}
					type="submit"
				>
					{pending ? "Dzwonię…" : "Zadzwoń"}
				</button>
			</div>
		</form>
	);
}
