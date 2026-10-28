import { describe, expect, it } from "vitest";

import { counterpartyLabel } from "./counterparty-label";

const known = {
	state: "known" as const,
	e164: "+48512345678",
	nameHint: null,
	contactName: null,
};

describe("counterpartyLabel — precedence", () => {
	it("the user's contact name wins over the operator's hint, number as secondary", () => {
		expect(
			counterpartyLabel({
				...known,
				nameHint: "Strona",
				contactName: "Zenobia",
			}),
		).toEqual({
			primary: "Zenobia",
			secondary: "+48 512 345 678",
			source: "contact",
		});
	});

	it("without a contact, the operator's hint — tagged as such", () => {
		expect(counterpartyLabel({ ...known, nameHint: "Strona" })).toEqual({
			primary: "Strona",
			secondary: "+48 512 345 678",
			source: "operator",
		});
	});

	it("without any name, the formatted number", () => {
		expect(counterpartyLabel(known)).toEqual({
			primary: "+48 512 345 678",
			source: "number",
		});
	});

	it("a foreign number passes through unformatted", () => {
		expect(counterpartyLabel({ ...known, e164: "+14155550100" })).toEqual({
			primary: "+14155550100",
			source: "number",
		});
	});

	it.each([
		["withheld", "operator nie podał"],
		["pending", "jeszcze nieznany"],
		["unavailable", "niedostępny"],
	] as const)("state %s reads %s", (state, text) => {
		expect(
			counterpartyLabel({
				state,
				e164: null,
				nameHint: null,
				contactName: null,
			}),
		).toEqual({ primary: text, source: "state" });
	});

	it("an empty-string name is not a name", () => {
		expect(
			counterpartyLabel({ ...known, nameHint: "", contactName: "" })?.source,
		).toBe("number");
	});

	it("a `known` row with no number never renders blank", () => {
		expect(counterpartyLabel({ ...known, e164: null })).toEqual({
			primary: "niedostępny",
			source: "state",
		});
	});

	it("a conversation captured before FR-025 shows nothing", () => {
		expect(counterpartyLabel(null)).toBeNull();
	});
});
