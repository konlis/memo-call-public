"use client";

import { signOut } from "next-auth/react";

// The only client island in the panel shell. `signOut` clears the Auth.js
// session cookie, then redirects to /login (the proxy would bounce there anyway
// once the session is gone, but an explicit callbackUrl avoids a flash of `/`).
export function SignOutButton() {
	return (
		<button
			className="rounded-md bg-white/10 px-3 py-1.5 font-medium text-sm text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 hover:text-white"
			onClick={() => void signOut({ callbackUrl: "/login" })}
			type="button"
		>
			Sign out
		</button>
	);
}
