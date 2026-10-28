import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { env } from "~/env";
import { credentialsAuthorize } from "./credentials-authorize";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export const { auth, handlers, signIn, signOut } = NextAuth({
	// Non-Vercel deployments (we run on Fly) need trustHost so Auth.js trusts
	// the x-forwarded-* headers Fly's edge sets.
	trustHost: true,
	secret: env.AUTH_SECRET,
	session: { strategy: "jwt", maxAge: THIRTY_DAYS_SECONDS },
	jwt: { maxAge: THIRTY_DAYS_SECONDS },
	pages: { signIn: "/login" },
	providers: [
		Credentials({
			credentials: {
				password: { label: "Password", type: "password" },
			},
			authorize: (credentials, request) =>
				credentialsAuthorize(credentials, request),
		}),
	],
	callbacks: {
		// JWT path: persist the single-user id in the token. Auth.js calls this
		// on every JWT mint (sign-in and refresh).
		jwt: ({ token }) => {
			token.userId = "me";
			return token;
		},
		// Shape session.user.id for consumers.
		session: ({ session, token }) => {
			if (session.user) {
				session.user.id = (token.userId as string) ?? "me";
			}
			return session;
		},
		// Used by the proxy/middleware-style auth wrapper to decide allow/deny.
		authorized: ({ auth: authState }) => !!authState?.user,
	},
});
