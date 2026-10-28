import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Boot guard on the telephony factory (impl-review F4).
 *
 * `TELEPHONY_PROVIDER` is the one provider enum whose default is an
 * AUTHORIZATION decision: the mock's `verifySignature` returns `true`
 * unconditionally, and `proxy.ts` excludes `/api/telephony/*` from the auth gate
 * because the signature IS the auth. A typo in the secret fails loud at the zod
 * enum; its ABSENCE used to be silent — the Machine booted healthy on the mock
 * and both webhooks accepted unsigned POSTs from anyone.
 *
 * These tests exist because a guard nobody has watched fire is not a guard:
 * each must fail if the condition in `createTelephony` is weakened.
 *
 * The factory builds its singleton at MODULE LOAD, so every case stubs the env
 * first, then `resetModules()` + dynamic-imports the barrel. A static import at
 * the top of this file would freeze one provider for the whole suite.
 *
 * Consequence worth knowing before "improving" these assertions: `resetModules`
 * re-evaluates `provider-error.ts` too, so the thrown `ProviderError` is a
 * DIFFERENT class identity than a statically-imported one and
 * `.toThrow(ProviderError)` fails despite a correct throw. Assert the shape
 * (`name` + `code`), not `instanceof` — same module-identity trap CLAUDE.md
 * documents for the LLM mock's schema matching.
 */
async function loadTelephonyBarrel() {
	vi.resetModules();
	return import("~/server/telephony");
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("telephony factory — production mock guard", () => {
	it("refuses the mock at a production runtime", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TELEPHONY_PROVIDER", "mock");
		vi.stubEnv("NEXT_PHASE", undefined);

		await expect(loadTelephonyBarrel()).rejects.toMatchObject({
			name: "ProviderError",
			code: "auth",
		});
		await expect(loadTelephonyBarrel()).rejects.toThrow(
			/refused in production/,
		);
	});

	it("still refuses when the secret is absent entirely — the enum default IS 'mock'", async () => {
		// The real-world shape of this bug: nobody sets a bad value, someone just
		// never sets the secret on a fresh Machine or a new fleet instance.
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TELEPHONY_PROVIDER", undefined);
		vi.stubEnv("NEXT_PHASE", undefined);

		await expect(loadTelephonyBarrel()).rejects.toMatchObject({ code: "auth" });
	});

	it("allows the mock during `next build` — same NODE_ENV, not a runtime", async () => {
		// `next build` runs with NODE_ENV=production and DOES evaluate this module,
		// because the tRPC routers import the barrel statically. Gating on NODE_ENV
		// alone would break the build — hence the NEXT_PHASE carve-out.
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TELEPHONY_PROVIDER", "mock");
		vi.stubEnv("NEXT_PHASE", "phase-production-build");

		const { telephony } = await loadTelephonyBarrel();
		expect(telephony.constructor.name).toBe("MockTelephonyProvider");
	});

	it("allows the mock in development", async () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("TELEPHONY_PROVIDER", "mock");
		vi.stubEnv("NEXT_PHASE", undefined);

		const { telephony } = await loadTelephonyBarrel();
		expect(telephony.constructor.name).toBe("MockTelephonyProvider");
	});
});

describe("telephony factory — zadarma branch", () => {
	function stubZadarmaEnv(overrides: Record<string, string | undefined> = {}) {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("NEXT_PHASE", undefined);
		vi.stubEnv("TELEPHONY_PROVIDER", "zadarma");
		const values: Record<string, string | undefined> = {
			ZADARMA_USER_KEY: "test-user-key",
			ZADARMA_SECRET: "test-secret",
			USER_FORWARD_NUMBER: "+48500100200",
			ZADARMA_SIP_EXTENSION: "100",
			...overrides,
		};
		for (const [key, value] of Object.entries(values))
			vi.stubEnv(key, value as string);
	}

	it("constructs the real provider when the credentials are present", async () => {
		stubZadarmaEnv();
		const { telephony } = await loadTelephonyBarrel();
		expect(telephony.constructor.name).toBe("ZadarmaTelephonyProvider");
	});

	// Fail LOUD at boot, never a silent fallback to the mock (whose verifySignature
	// accepts every webhook). The throw comes from the provider's own constructor,
	// exactly like the twilio branch and the STT/LLM real branches.
	it("crashes at module load when ZADARMA_SECRET is absent", async () => {
		stubZadarmaEnv({ ZADARMA_SECRET: undefined });
		await expect(loadTelephonyBarrel()).rejects.toMatchObject({
			name: "ProviderError",
			code: "auth",
		});
		await expect(loadTelephonyBarrel()).rejects.toThrow(/secret/);
	});

	// ZADARMA_SIP_EXTENSION is OUTBOUND-only (F1). Coupling it to construction
	// would crash the live inbound path at boot over a secret inbound never uses;
	// `placeCall` validates it lazily instead (see zadarma.test.ts).
	it("boots WITHOUT ZADARMA_SIP_EXTENSION — outbound-only credential", async () => {
		stubZadarmaEnv({ ZADARMA_SIP_EXTENSION: undefined });
		const { telephony } = await loadTelephonyBarrel();
		expect(telephony.constructor.name).toBe("ZadarmaTelephonyProvider");
	});

	// The twilio branch guards PUBLIC_BASE_URL because Twilio's HMAC covers the
	// URL. Zadarma's does not, and its notification URL lives in the vendor panel,
	// so requiring the secret here would block inbound boot for nothing. Pinned so
	// nobody "restores consistency" with the branch above it.
	it("boots WITHOUT PUBLIC_BASE_URL — unlike the twilio branch, by design", async () => {
		stubZadarmaEnv();
		vi.stubEnv("PUBLIC_BASE_URL", undefined);
		const { telephony } = await loadTelephonyBarrel();
		expect(telephony.constructor.name).toBe("ZadarmaTelephonyProvider");
	});
});
