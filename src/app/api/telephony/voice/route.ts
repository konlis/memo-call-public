import { env } from "~/env";
import { handleVoiceWebhook } from "~/server/telephony/webhooks";

// Twilio posts application/x-www-form-urlencoded — this is a raw Route Handler,
// NOT a tRPC procedure. The signature IS the auth (no session); the handler 403s
// on mismatch. The `twilio` SDK uses Node APIs (Buffer/crypto), so pin the Node
// runtime explicitly. Excluded from the proxy gate via its `api/telephony` matcher token.
export const runtime = "nodejs";

/**
 * `~/server/telephony` is resolved at REQUEST time: its `index.ts` constructs the
 * provider singleton at module load, so a static import made this module
 * un-importable in a test. Same reasoning (and same precedent,
 * `src/instrumentation.ts`) as the recording-status handler next door — see the
 * longer note there.
 */
export async function POST(request: Request): Promise<Response> {
	const { telephony } = await import("~/server/telephony");

	return handleVoiceWebhook(request, {
		telephony,
		publicBaseUrl: env.PUBLIC_BASE_URL,
	});
}
