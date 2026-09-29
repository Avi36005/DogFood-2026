#!/bin/sh
# Migrations and seeding are part of starting up. Both are idempotent, so a
# restart against an existing volume changes nothing and loses nothing.
set -e

echo "[forgeboard] applying schema…"
node scripts/migrate.ts

if [ "${FORGEBOARD_SEED:-1}" = "1" ]; then
  echo "[forgeboard] importing the DOGFOOD fixtures (set FORGEBOARD_SEED=0 to skip)…"
  node scripts/seed-fixtures.ts
  echo "[forgeboard] seeding the walkthrough event (unfinished reviews, drafts, a withdrawn entry)…"
  node scripts/seed.ts
fi

echo "[forgeboard] listening on http://localhost:3000"
exec npx --no-install next start -p 3000
