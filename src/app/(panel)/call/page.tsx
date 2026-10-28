import { CallForm } from "./_components/call-form";

// Outbound click-to-call surface (US-01 / FR-001). Server shell only — no data
// fetch (so no `dynamic = "force-dynamic"` needed, unlike the DB-reading list
// pages); the interactive form is the client component. Placing a call rings the
// user's own GSM first, then bridges to the recipient; the resulting recording
// flows through the same pipeline as an inbound call and appears in
// `/conversations` after hang-up.
export default function CallPage() {
	return (
		<div className="flex max-w-xl flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="font-bold text-2xl tracking-tight">Zadzwoń</h1>
				<p className="text-sm text-white/60">
					Wpisz numer rozmówcy. MemoCall zadzwoni najpierw na Twój telefon —
					odbierz, a połączenie zostanie zestawione z rozmówcą i nagrane.
					Transkrypcja i analiza pojawią się na liście rozmów po zakończeniu.
				</p>
			</div>
			<CallForm />
		</div>
	);
}
