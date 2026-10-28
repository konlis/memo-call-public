/**
 * Polish alphabetical order for contact names, applied on the CLIENT.
 *
 * ⚠️ `contacts.list` already carries `ORDER BY name ASC`, and that is NOT the
 * order a Polish reader expects (impl-review phase 3, F6). SQLite's default
 * collation is `BINARY` — byte order — so measured on the real database:
 *
 *   Basia | Zofia | anna | ąla | Ćma | Łukasz
 *
 * Every lowercase letter sorts after every uppercase one, and every Polish
 * diacritic sorts after the whole ASCII range. `Intl.Collator("pl")` is what
 * actually implements the promise the UI makes.
 *
 * Kept on the client rather than "fixed" in SQL on purpose: SQLite has no
 * locale-aware collation without a custom one registered per connection, and
 * the server order still earns its keep — it makes the index-backed read
 * deterministic and is close enough for anything that is not shown to a human.
 * The list is a contact book, dozens of rows, so re-sorting costs nothing.
 *
 * Both screens that display contacts import THIS, so they cannot disagree —
 * the same reason `phone-display.ts` exists.
 */
const collator = new Intl.Collator("pl", { sensitivity: "base" });

/** Returns a new array; never mutates the react-query cache's array in place. */
export function sortByPolishName<T extends { name: string }>(
	contacts: readonly T[],
): T[] {
	return [...contacts].sort((a, b) => collator.compare(a.name, b.name));
}
