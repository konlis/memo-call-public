"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { type FormEvent, useId, useState } from "react";

// Single generic message for every failure mode (wrong password / locked /
// throttled / no-config). The precise reason lives only in the server-side
// audit log — info-leak-safe per FR-008. Auth.js's "CredentialsSignin" error
// code is never surfaced to the user.
const GENERIC_ERROR = "Wrong password or account locked. Try again later.";

// Accept only same-origin in-app paths. Rejects external absolute URLs,
// protocol-relative `//host`, and the `/\host` backslash variant that some
// browsers normalise to `//host`. Everything else collapses to the root panel.
function safeCallbackUrl(raw: string | null): string {
	if (!raw?.startsWith("/")) return "/";
	if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
	return raw;
}

export function LoginForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const passwordId = useId();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setPending(true);
		try {
			const result = await signIn("credentials", {
				password,
				redirect: false,
			});
			// next-auth v5 quirk: with `redirect: false`, `result.ok` is `true`
			// even on a FAILED credentials attempt — the failure is carried in
			// `result.error` ("CredentialsSignin"). Branch on `error`, not `ok`,
			// or a wrong password silently "succeeds", pushes to `/`, bounces off
			// the proxy gate back to `/login`, and shows the user nothing.
			if (result?.error) {
				setError(GENERIC_ERROR);
				return;
			}
			// callbackUrl is set by the proxy gate when it bounces an
			// unauthenticated request here. It is attacker-controllable (the
			// /login route is public), so validate it is a same-origin relative
			// path before navigating — otherwise `?callbackUrl=https://evil.com`
			// (or protocol-relative `//evil.com` / backslash `/\evil.com`) turns
			// a successful login into an open-redirect phishing vector. Anything
			// that is not a plain in-app path falls back to the root panel.
			router.push(safeCallbackUrl(searchParams.get("callbackUrl")));
			router.refresh();
		} catch {
			// Network / unexpected — same generic copy, no detail leak.
			setError(GENERIC_ERROR);
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="flex w-full flex-col gap-4" onSubmit={onSubmit}>
			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}
			<div className="flex flex-col gap-2">
				<label
					className="font-medium text-sm text-white/80"
					htmlFor={passwordId}
				>
					Password
				</label>
				<input
					autoComplete="current-password"
					className="rounded-md bg-white/10 px-3 py-2 text-white placeholder-white/40 outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
					disabled={pending}
					id={passwordId}
					onChange={(e) => setPassword(e.target.value)}
					required
					type="password"
					value={password}
				/>
			</div>
			<button
				className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
				disabled={pending}
				type="submit"
			>
				{pending ? "Signing in…" : "Sign in"}
			</button>
		</form>
	);
}
