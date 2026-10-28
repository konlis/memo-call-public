import { formatForDisplay } from "./phone-display";

/**
 * Who a conversation was with, as ONE line of text (FR-025).
 *
 * The router deliberately returns every counterparty field and decides
 * nothing (`conversations.list` / `getById`); the precedence lives HERE, and
 * both the list row and the detail view import it, so the two screens cannot
 * disagree about whom a conversation was with — the same reason
 * `phone-display.ts` and `contact-order.ts` exist.
 *
 * Precedence: the user's own contact name → the name the OPERATOR attached to
 * the number (a hint, never a contact — the UI must say where it came from) →
 * the number itself → an explicit state. A conversation captured before
 * FR-025 (`counterparty === null`) yields `null`: it has no state at all and
 * the panel shows nothing, rather than a "not known yet" that would never
 * resolve (no backfill — decision #4).
 */
export type CounterpartyInput = {
	state: "pending" | "known" | "withheld" | "unavailable";
	e164: string | null;
	nameHint: string | null;
	contactName: string | null;
} | null;

export type CounterpartyLabel = {
	primary: string;
	/** The formatted number, when `primary` is a name. */
	secondary?: string;
	source: "contact" | "operator" | "number" | "state";
};

const STATE_TEXT = {
	withheld: "operator nie podał",
	pending: "jeszcze nieznany",
	unavailable: "niedostępny",
} as const;

export function counterpartyLabel(
	c: CounterpartyInput,
): CounterpartyLabel | null {
	if (c === null) return null;
	const number = c.e164 === null ? undefined : formatForDisplay(c.e164);
	if (c.contactName) {
		return { primary: c.contactName, secondary: number, source: "contact" };
	}
	if (c.nameHint) {
		return { primary: c.nameHint, secondary: number, source: "operator" };
	}
	if (number !== undefined) return { primary: number, source: "number" };
	// `known` always carries a number (the resolver writes both or neither);
	// should that ever break, "unavailable" is the honest reading.
	return {
		primary: STATE_TEXT[c.state === "known" ? "unavailable" : c.state],
		source: "state",
	};
}
