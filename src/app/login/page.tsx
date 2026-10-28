import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "./_components/login-form";

export const metadata: Metadata = {
	title: "Sign in — MemoCall",
};

// Server component shell. No data fetching — the client form owns the auth call.
// Reuses the `page.tsx` gradient for visual continuity.
export default function LoginPage() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
			<div className="container flex max-w-sm flex-col items-center justify-center gap-6 px-4 py-16">
				<div className="flex flex-col items-center gap-2 text-center">
					<h1 className="font-extrabold text-4xl tracking-tight sm:text-5xl">
						MemoCall
					</h1>
					<p className="text-lg text-white/70">Sign in to continue</p>
				</div>
				{/*
				 * Suspense boundary is REQUIRED: LoginForm reads useSearchParams()
				 * (for callbackUrl). On a statically-rendered route, Next.js 16 fails
				 * the build with "useSearchParams() should be wrapped in a suspense
				 * boundary" without this wrapper.
				 */}
				<Suspense fallback={<LoginFormFallback />}>
					<LoginForm />
				</Suspense>
			</div>
		</main>
	);
}

// Minimal skeleton matching the form's footprint so the layout doesn't jump
// during the brief client-render of the Suspense child.
function LoginFormFallback() {
	return (
		<div className="flex w-full flex-col gap-4">
			<div className="h-[72px] w-full" />
			<div className="h-10 w-full rounded-md bg-white/10" />
		</div>
	);
}
