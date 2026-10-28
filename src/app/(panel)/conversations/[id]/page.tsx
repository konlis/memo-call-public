import { api, HydrateClient } from "~/trpc/server";

import { ConversationDetail } from "./_components/conversation-detail";

// Conversation detail (S-03 / FR-023 fetch-on-page-load). Prefetch the full
// payload on the server and hydrate it so the page paints without a client
// round-trip; the client component then owns the override form + invalidation.
// `projects.list` is prefetched too because the override form's project select
// is filtered against it. A foreign/unknown id makes `getById` throw NOT_FOUND
// during prefetch → the hydrated query lands in an error state and the client
// renders an in-panel "not found" (keeps the panel chrome; no data leak).
// `force-dynamic`: both prefetches are DB reads, so this RSC must opt out of
// static prerender or the build hits the empty placeholder DB ("no such table";
// CLAUDE.md "Lessons" "a green build ≠ deploy").
export const dynamic = "force-dynamic";

export default async function ConversationDetailPage({
	params,
}: {
	// Next.js 16: dynamic route params arrive as a Promise.
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	void api.conversations.getById.prefetch({ id });
	void api.projects.list.prefetch();

	return (
		<HydrateClient>
			<ConversationDetail id={id} />
		</HydrateClient>
	);
}
