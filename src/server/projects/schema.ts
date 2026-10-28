import { z } from "zod";

import { categorySchema } from "~/server/llm/schemas";

/**
 * Shared project-creation input — importable by BOTH the `projects` router
 * (server validation) and the client add-form (pre-validation), mirroring how
 * `setup` shares `password-rules`. Zero server-only imports so the client can
 * pull it without dragging server deps in.
 *
 * `name` uses `z.string().trim()` (NOT `.transform(s => s.trim())`): `.trim()`
 * returns a `ZodString`, so it stays chainable with `.min`/`.max` AND yields the
 * trimmed value — normalizing identically on client + server, and trimming
 * BEFORE both the length check and the router's case-insensitive uniqueness
 * check. (`.transform()` returns `ZodEffects`, which has no `.min`/`.max`.)
 * `category` reuses `categorySchema` — it does not redefine the enum.
 */
export const createProjectInput = z.object({
	name: z.string().trim().min(1).max(60),
	category: categorySchema,
});

export type CreateProjectInput = z.infer<typeof createProjectInput>;
