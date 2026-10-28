import { handleChallenge } from "~/server/telephony/webhooks";

// The ONE URL registered in a single-notification-URL provider's panel (Zadarma:
// Settings → Integrations and API → notifications). It receives every event type
// that provider emits — for Zadarma eight of them, of which only NOTIFY_RECORD
// is actionable — plus the GET handshake it performs when the URL is saved.
//
// Raw Route Handler, not a tRPC procedure: the provider posts form-encoded and
// holds no session. The signature IS the auth, enforced one layer down in
// `webhooks.ts`. Node runtime is pinned because the provider implementations use
// Node crypto. Excluded from the proxy gate via its `api/telephony` matcher token.
export const runtime = "nodejs";

/**
 * POST is the SAME handler wiring as `../recording-status/route.ts`, re-exported
 * rather than copied.
 *
 * Two URLs reach one job ingress because the providers differ in how the callback
 * address is chosen, not in what the callback means: Twilio is told the URL per
 * call (`recordingStatusCallback` inside the TwiML we generate), Zadarma has one
 * notification URL per ACCOUNT, set in its panel. Re-exporting makes "the same
 * dependencies" a fact rather than a convention — a dep added to one ingress
 * cannot silently miss the other. The re-exported module keeps its imports lazy
 * (see the long note in its header), so importing THIS module opens no libsql
 * connection either, which `../import-clean.test.ts` pins.
 *
 * THE GUARANTEE COVERS HANDLER DEPS, NOT ROUTE SEGMENT CONFIG (impl-review
 * phase 3, F8). Next reads `runtime` / `dynamic` / `maxDuration` / `revalidate`
 * per FILE, so they are NOT inherited through a re-export: `runtime` is declared
 * independently above, and any segment config added to the sibling must be
 * duplicated here by hand or it silently will not apply to this route.
 */
export { POST } from "../recording-status/route";

/**
 * URL-verification handshake. The provider GETs this URL with a challenge in the
 * query string when the operator saves it, and refuses to save unless the exact
 * value comes back. Unauthenticated by construction and side-effect-free — see
 * `handleChallenge` in `webhooks.ts`.
 *
 * `~/server/telephony` is resolved at REQUEST time for the same reason as on the
 * POST path: its `index.ts` constructs the provider singleton at module load, so
 * a static import would make this module un-importable in a test.
 */
export async function GET(request: Request): Promise<Response> {
	const { telephony } = await import("~/server/telephony");

	return handleChallenge(request, { telephony });
}
