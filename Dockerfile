# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired.
# Node 22 (not 20) is REQUIRED, not cosmetic: ai@7 / @openrouter/ai-sdk-provider@3
# / @ai-sdk/gateway@4 all declare `engines: { node: ">=22" }`. There is no
# .npmrc, so engine-strict is off and `npm ci` would happily build a green image
# on Node 20 with those packages on an unsupported runtime — the failure would
# surface in production, on a rarely-hit code path, not here. See CLAUDE.md
# "Docker build pattern".
ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Next.js"

# Next.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules.
# Dockerfile fix #6 (F-03): the base image bundles npm 10.x (node:20.20.0-slim
# shipped 10.8.2; node:22.x-slim ships 10.9.x — still a major behind), but the
# committed package-lock.json is generated locally with npm 11.
# When F-03 added `tsx` (which pulls esbuild@0.28.0 + its 26 @esbuild/* platform
# optional-deps), npm 11 wrote those lock entries in a form npm 10.8.2's strict
# `npm ci` rejects ("Missing: esbuild@0.28.0 from lock file"). Align the
# builder's npm with the lock's generator before `npm ci`. Keep this pin in sync
# with the npm major used locally to regenerate the lock. See CLAUDE.md
# "Docker build pattern".
RUN npm install -g npm@11.15.0
COPY package-lock.json package.json ./
RUN npm ci --include=dev

# Copy application code
COPY . .

# Build application
# Standard Next.js Docker build (NOT --experimental-build-mode compile/generate).
# The two-stage experimental pattern is incompatible with Next.js `output: "standalone"`
# because standalone bundles only the runtime, not the Next.js CLI — at machine boot,
# `npx next build generate` exits with rc=127 (command not found).
# SKIP_ENV_VALIDATION inline: env.js (imported by next.config.js) requires DATABASE_URL,
# which isn't in Docker build context (excluded by .dockerignore). Runtime gets DATABASE_URL
# from Fly secrets and standalone server.js doesn't re-validate at boot.
RUN SKIP_ENV_VALIDATION=true DATABASE_URL="file:/tmp/build-placeholder.db" npx next build

# Remove development dependencies
RUN npm prune --omit=dev


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app/.next/standalone /app
COPY --from=build /app/.next/static /app/.next/static
COPY --from=build /app/public /app/public

# The boot-time migrator (docker-entrypoint.sh below runs `node scripts/migrate.mjs`
# before server.js) executes OUTSIDE the Next.js routing graph. Next.js's
# `outputFileTracingIncludes` in next.config.js copies scripts/ and drizzle/ into
# the standalone bundle BUT does NOT trace their imports — drizzle-orm and
# @libsql/client never land in standalone's node_modules. Without the COPY below,
# the migrator fails with `Cannot find package 'drizzle-orm'` (verified F-01 deploy).
# Copy the build stage's full prod node_modules to make every package the migrator
# might need resolvable. Adds ~70-100 MB; acceptable for MVP since the migrator
# runs once per boot. Standalone's own (subset) node_modules remains intact —
# this is additive.
COPY --from=build /app/node_modules /app/node_modules

# Wrapper that runs `node scripts/migrate.mjs` then exec's `node server.js`.
# Why NOT `fly.toml [deploy] release_command` (the textbook Fly migration hook):
# its one-off Machine can't attach the same Volume as the running app Machine
# (single-volume single-Machine setup → SQLITE_CANTOPEN err 14, verified F-01
# deploy attempt 2). Running the migrator at app-Machine boot keeps the
# fail-fast semantic (boot crash → Fly rollback) without the volume contention.
# See docker-entrypoint.sh header for details.
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000
CMD [ "/app/docker-entrypoint.sh" ]
