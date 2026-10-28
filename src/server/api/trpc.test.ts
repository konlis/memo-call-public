import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

// `trpc.ts` imports `auth()` (next-auth → next/server, unresolvable under
// vitest) — same stub as the router suites.
vi.mock("~/server/auth", () => ({ auth: async () => null }));

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

// The error formatter is the last stop before a message reaches the browser.
// These tests go through the real fetch adapter, because `createCaller` throws
// the TRPCError directly and never runs the formatter.
const router = createTRPCRouter({
	rawDbError: publicProcedure.query(() => {
		throw new Error(
			'Failed query: update "memo-call_contacts" set "e164" = ?\nparams: +48512345678,Zenobia Testowa',
		);
	}),
	conflict: publicProcedure.query(() => {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Ten numer należy już do kontaktu „Zenobia”",
		});
	}),
	configError: publicProcedure.query(() => {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "PUBLIC_BASE_URL is not set",
		});
	}),
});

async function errorOf(path: string): Promise<{
	message: string;
	data: Record<string, unknown>;
}> {
	const res = await fetchRequestHandler({
		endpoint: "/api/trpc",
		req: new Request(`http://localhost/api/trpc/${path}`),
		router,
		createContext: () => ({}) as never,
	});
	const body = (await res.json()) as {
		error: { json: { message: string; data: Record<string, unknown> } };
	};
	return body.error.json;
}

describe("errorFormatter — what a failed procedure sends to the browser", () => {
	test("an unexpected error (e.g. a failed drizzle query) is replaced by a constant — no bound params, no stack", async () => {
		const err = await errorOf("rawDbError");
		expect(err.message).toBe("Internal server error");
		expect(err.data.code).toBe("INTERNAL_SERVER_ERROR");
		expect(err.data.stack).toBeUndefined();
		const wire = JSON.stringify(err);
		expect(wire.replace(/\D/g, "")).not.toContain("512345678");
		expect(wire).not.toContain("Zenobia");
		expect(wire).not.toContain("params");
	});

	test("our own TRPCErrors keep their deliberate messages", async () => {
		expect((await errorOf("conflict")).message).toBe(
			"Ten numer należy już do kontaktu „Zenobia”",
		);
		expect((await errorOf("configError")).message).toBe(
			"PUBLIC_BASE_URL is not set",
		);
	});
});
