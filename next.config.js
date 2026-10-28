/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
	output: "standalone",
	// Force standalone bundle to include scripts/ and drizzle/ so the runtime
	// migrator (Fly release_command, see fly.toml [deploy]) has access to
	// scripts/migrate.mjs and the SQL files at /app. Tracing migrate.mjs's
	// imports also pulls drizzle-orm/libsql/migrator + @libsql/client into
	// the standalone node_modules. Required since the migrator runs OUTSIDE
	// the Next.js runtime — Next won't trace it by default.
	outputFileTracingIncludes: {
		"/": ["./scripts/**/*", "./drizzle/**/*"],
	},
};

export default config;
