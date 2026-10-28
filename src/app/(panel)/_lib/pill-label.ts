import { formatForDisplay } from "~/app/(panel)/_lib/phone-display";

/**
 * How a dialing-history pill in `/call` is labelled. Lives here rather than
 * inside `call-form.tsx` for the reason `phone-display.ts` and
 * `contact-order.ts` do: a pure rule worth pinning with a test, in a file that
 * does not have to be rendered to be exercised (`happy-dom` is still not
 * installed — see CLAUDE.md "Testing").
 */

/**
 * The names carried by more than one history row — i.e. the ones a bare-name
 * pill would render ambiguously. `contacts` deliberately has no uniqueness on
 * `name` (impl-review phase 1 / F7, SKIPPED with "reconsider at the phase-3
 * picker"), so two different numbers can both be signed "Marek".
 *
 * ⚠️ Ambiguity is computed from the HISTORY rows alone, and the `entries` type
 * is narrow on purpose so it cannot quietly start taking `contacts.list` rows
 * instead. That query can fail while `calls.history` succeeds (full-plan
 * impl-review, F1), and a disambiguation that switches itself off when an
 * unrelated request fails is worse than one that never existed.
 */
export function ambiguousContactNames(
	entries: readonly { contactName: string | null }[],
): ReadonlySet<string> {
	const seen = new Set<string>();
	const ambiguous = new Set<string>();
	for (const { contactName } of entries) {
		if (contactName === null) continue;
		if (seen.has(contactName)) ambiguous.add(contactName);
		seen.add(contactName);
	}
	return ambiguous;
}

/**
 * What a pill says, and — reused verbatim — what its removal button announces.
 * An unsigned number renders formatted; a signed one renders the name, widened
 * to `name · number` when that name is not unique on this screen (full-plan
 * impl-review, F4). Two identical pills were bad enough; two identical
 * `aria-label`s on the only destructive control there meant a screen reader
 * could not say which number it was about to forget. The widened form is the
 * SAME shape the "Kontakt" select uses, so the two controls disambiguate alike.
 */
export function pillLabel(
	contactName: string | null,
	e164: string,
	ambiguous: ReadonlySet<string>,
): string {
	if (contactName === null) return formatForDisplay(e164);
	if (ambiguous.has(contactName)) {
		return `${contactName} · ${formatForDisplay(e164)}`;
	}
	return contactName;
}
