import Link from "next/link";

import { SignOutButton } from "./_components/sign-out-button";

/**
 * Authenticated panel chrome (S-04). The route-group `(panel)` keeps URLs clean
 * (`/conversations`, not `/(panel)/conversations`) and provides the persistent
 * nav that the sibling slices mount into — S-02 (`/projects`), S-03 (detail),
 * S-05 (tags), S-06 (transcript). Auth is delegated entirely to `src/proxy.ts`:
 * this layout assumes a session and does no auth check itself.
 */
export default function PanelLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<div className="flex min-h-screen flex-col bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
			<header className="border-white/10 border-b">
				<div className="container mx-auto flex items-center justify-between gap-4 px-4 py-4">
					<div className="flex items-center gap-6">
						<Link
							className="font-extrabold text-xl tracking-tight"
							href="/conversations"
						>
							MemoCall
						</Link>
						<nav className="flex items-center gap-4 text-sm">
							<Link
								className="text-white/80 transition hover:text-white"
								href="/conversations"
							>
								Conversations
							</Link>
							{/* Activated by OPT-25 (outbound-click-to-call): `/call` now exists. */}
							<Link
								className="text-white/80 transition hover:text-white"
								href="/call"
							>
								Zadzwoń
							</Link>
							{/* Activated by `contact-directory`: `/contacts` now exists. */}
							<Link
								className="text-white/80 transition hover:text-white"
								href="/contacts"
							>
								Kontakty
							</Link>
							{/* Activated by S-02 (project-management): `/projects` now exists. */}
							<Link
								className="text-white/80 transition hover:text-white"
								href="/projects"
							>
								Projects
							</Link>
						</nav>
					</div>
					<SignOutButton />
				</div>
			</header>
			<main className="container mx-auto w-full flex-1 px-4 py-8">
				{children}
			</main>
		</div>
	);
}
