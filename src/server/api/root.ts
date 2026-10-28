import { callsRouter } from "~/server/api/routers/calls";
import { contactsRouter } from "~/server/api/routers/contacts";
import { conversationsRouter } from "~/server/api/routers/conversations";
import { jobsRouter } from "~/server/api/routers/jobs";
import { projectsRouter } from "~/server/api/routers/projects";
import { setupRouter } from "~/server/api/routers/setup";
import { tagsRouter } from "~/server/api/routers/tags";
import {
	createCallerFactory,
	createTRPCRouter,
	publicProcedure,
} from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
	// Placeholder: removable as soon as the first real router lands. See F-01 Phase 1 §3.
	health: publicProcedure.query(() => "ok"),
	setup: setupRouter,
	jobs: jobsRouter,
	conversations: conversationsRouter,
	projects: projectsRouter,
	calls: callsRouter,
	contacts: contactsRouter,
	tags: tagsRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 */
export const createCaller = createCallerFactory(appRouter);
