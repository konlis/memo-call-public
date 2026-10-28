import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { db } from "~/server/db";
import { authConfig } from "~/server/db/schema";
import { SetupForm } from "./_components/setup-form";

export const metadata: Metadata = {
	title: "Setup — MemoCall",
};

// Render per-request, never at build time. This page reads live DB state
// (is a password already set?) to decide notFound() vs. render. At `next build`
// the only DATABASE_URL is the empty placeholder (file:/tmp/build-placeholder.db
// — no migrations run at build), so prerendering would crash with
// "no such table: memo-call_auth_config". force-dynamic keeps the query at
// runtime, where the migrated Volume DB exists. (Local builds masked this
// because they point at the real ./db.sqlite.)
export const dynamic = "force-dynamic";

// Server component. One-shot wizard: if a password is already set, 404 so the
// route can't be used to probe or re-run setup. The proxy also stops routing
// here once password_hash is non-null, but this is the authoritative guard.
export default async function SetupPage() {
	const row = await db.query.authConfig.findFirst({
		where: eq(authConfig.userId, "me"),
	});
	if (row?.passwordHash) {
		notFound();
	}

	return (
		<main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
			<div className="container flex max-w-md flex-col items-center justify-center gap-6 px-4 py-16">
				<div className="flex flex-col items-center gap-2 text-center">
					<h1 className="font-extrabold text-3xl tracking-tight sm:text-4xl">
						MemoCall — First-run setup
					</h1>
					<p className="text-white/70">Set your password to get started.</p>
				</div>

				<SetupForm />

				{/* Placeholders for the S-01 provider-credential steps. Purely
				    informational, non-interactive text styled to read as "coming
				    later" — no ARIA role needed (the label text suffices for AT). */}
				<div className="flex w-full flex-col gap-2">
					{[
						"Telephony — set up in S-01",
						"Cloud STT — S-01",
						"Cloud LLM — S-01",
					].map((label) => (
						<div
							className="rounded-md bg-white/5 px-4 py-3 text-sm text-white/40"
							key={label}
						>
							{label}
						</div>
					))}
				</div>
			</div>
		</main>
	);
}
