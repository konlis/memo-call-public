import { api, HydrateClient } from "~/trpc/server";

import { ProjectsView } from "./_components/projects-view";

// Projects management (PRD FR-013/014/015), mounted in the `(panel)` shell.
// Prefetch the flat grouped list on the server and hydrate it so it paints
// without a client round-trip. Unlike the conversations page this uses plain
// `prefetch` (NOT prefetchInfinite) — `projects.list` is a single, non-paginated
// grouped query with no cursor input. The prefetch runs the server caller → a DB
// read, so this RSC MUST opt out of static prerender or the build hits the empty
// placeholder DB ("no such table"; CLAUDE.md "Lessons": "a green build ≠ deploy").
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
	void api.projects.list.prefetch();

	return (
		<HydrateClient>
			<ProjectsView />
		</HydrateClient>
	);
}
