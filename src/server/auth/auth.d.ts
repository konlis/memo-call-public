// Module augmentation for Auth.js v5. We add `id` to Session.user and
// `userId` to the JWT payload — both populated in the callbacks in config.ts.
// Canonical pattern per https://authjs.dev/getting-started/typescript.

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
	interface Session {
		user: {
			id: string;
		} & DefaultSession["user"];
	}
}

declare module "next-auth/jwt" {
	interface JWT {
		userId?: string;
	}
}
