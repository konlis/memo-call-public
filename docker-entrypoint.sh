#!/bin/sh
# Runs on every Fly Machine boot, BEFORE traffic-receiving server.js starts.
#
# Why here instead of fly.toml [deploy] release_command:
#   Fly release_command runs in a separate ephemeral Machine. With a single
#   /data Volume + single always-on Machine, the release_command Machine
#   cannot attach the Volume while the running app Machine holds it
#   (SQLITE_CANTOPEN err 14 — verified Phase 3 deploy attempt 2). So the
#   migrator runs here instead, on the app Machine, AFTER /data is mounted.
#
# Failure semantics: `set -e` + non-zero `scripts/migrate.mjs` exit makes
# this script exit non-zero; the container exits; Fly detects boot failure
# via health-check timeout and rolls back to the previous Machine version.
# Same fail-fast safety as release_command, just at the Machine-boot layer.
#
# Idempotency: the migrator checks __drizzle_migrations and applies only
# pending. Safe to run on every boot — typically a sub-second no-op.

set -e

echo "[entrypoint] Running database migrations..."
node scripts/migrate.mjs

echo "[entrypoint] Migrations complete; starting Next.js standalone server..."
exec node server.js
