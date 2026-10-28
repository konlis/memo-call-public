/**
 * Presentation-only grouping of a Polish E.164 number
 * (`+48600100200` → `+48 600 100 200`). Anything that does not match falls
 * through unchanged.
 *
 * ⚠️ DELIBERATELY NOT IN `~/server/telephony/phone`. That module owns the
 * normalization *rule* — the single boundary deciding what may reach the
 * telephony provider. This is a rendering concern and must never become a
 * second place that decides what a valid number is: it only reformats a string
 * it already recognizes, and returns every other input untouched.
 *
 * Lives here rather than inside one component because BOTH `/call` (the dialing
 * history pills) and `/contacts` (the contact list) render the same stored
 * value, and they showed it two different ways until `contact-directory`
 * phase 3 (impl-review phase 2, F4). One formatter is what keeps them honest.
 */
export function formatForDisplay(e164: string): string {
	const m = /^\+48(\d{3})(\d{3})(\d{3})$/.exec(e164);
	return m ? `+48 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
