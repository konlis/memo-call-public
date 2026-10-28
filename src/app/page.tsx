import { redirect } from "next/navigation";

// Post-login landing → the panel home (the conversation list). `src/proxy.ts`
// already gates `/`, so an unauthenticated hit is bounced to /login before it
// ever reaches this redirect; an authenticated hit lands on /conversations.
export default function Home() {
	redirect("/conversations");
}
