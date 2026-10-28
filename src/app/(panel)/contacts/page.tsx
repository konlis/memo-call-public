import { api, HydrateClient } from "~/trpc/server";

import { ContactsView } from "./_components/contacts-view";

// Contact book (`contact-directory`), mounted in the `(panel)` shell. Prefetch
// the flat alphabetical list on the server and hydrate it so it paints without a
// client round-trip — plain `prefetch` (NOT prefetchInfinite), because
// `contacts.list` is a single non-paginated query with no cursor input. The
// prefetch runs the server caller → a DB read, so this RSC MUST opt out of
// static prerender or the build hits the empty placeholder DB ("no such table";
// lessons.md: "a green build ≠ deploy").
export const dynamic = "force-dynamic";

export default async function ContactsPage() {
	void api.contacts.list.prefetch();

	return (
		<HydrateClient>
			<ContactsView />
		</HydrateClient>
	);
}
