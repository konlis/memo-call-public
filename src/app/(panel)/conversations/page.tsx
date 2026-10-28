import { api, HydrateClient } from "~/trpc/server";

import { ConversationsView } from "./_components/conversations-view";
import { PAGE_SIZE } from "./_lib/list-config";

// Panel home (PRD FR-010/FR-011). Prefetch the first page on the server and
// hydrate it so the list paints without a client round-trip; the client
// component then owns category filtering + "load more" via useInfiniteQuery.
// The prefetch input MUST match the client's DEFAULT (no-filter) query key
// (`{ limit: PAGE_SIZE }`) for the hydrated page to land — see conversations-view.
// The prefetch runs the server caller → a DB read. Without this, Next.js tries
// to STATICALLY prerender `/conversations` at build time, where it hits the empty
// placeholder DB ("no such table") and fails the build (CLAUDE.md "Lessons": "a green
// build ≠ deploy" — DB-querying RSCs must opt out of static prerender).
export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
	void api.conversations.list.prefetchInfinite({ limit: PAGE_SIZE });

	return (
		<HydrateClient>
			<ConversationsView />
		</HydrateClient>
	);
}
