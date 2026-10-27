#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
node scripts/workspace-config.cjs
[ ! -e .installer/runtime.sock ] || { echo 'Managed runtime socket already exists. Stop the running workspace first; remove a stale socket only after verifying no supervisor is running.' >&2; exit 1; }
DATABASE=$(node -p 'require("./.installer/credentials.json").database')
TEMPORAL=$(node -p 'require("./.installer/credentials.json").temporal')
REDIS=$(node -p 'require("./.installer/credentials.json").redis || "external"')
command -v tsx >/dev/null || { echo 'Install tsx 4.23.15 once before starting workers (the devcontainer includes it).' >&2; exit 1; }
if [ "$TEMPORAL" = local ]; then
    command -v temporal >/dev/null || { echo 'Temporal CLI is required for local mode.' >&2; exit 1; }
fi
if [ "$DATABASE" = local ] || [ "$REDIS" = local ]; then
    command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo 'A running Docker daemon is required.' >&2; exit 1; }
    docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
fi
if [ "$DATABASE" = local ]; then
    command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo 'A running Docker daemon is required.' >&2; exit 1; }
    command -v supabase >/dev/null || { echo 'Supabase CLI is required.' >&2; exit 1; }
    # The historical snapshot contains external webhook destinations. Fail before starting or seeding it.
    if grep -RqE 'https?://backend\.(uncodie|makinari)\.com' makinari-db-scheme/supabase/migrations; then
        echo 'Unsafe schema: external backend webhooks detected. Prepare a reviewed local-only schema before startup.' >&2
        exit 1
    fi
    (cd makinari-db-scheme && supabase start && supabase migration up --local)
    (cd makinari-db-scheme && supabase status -o json) | node scripts/workspace-config.cjs --supabase-status
else
    node scripts/workspace-config.cjs --apply
fi
if [ "$REDIS" = local ]; then
    node scripts/local-redis.cjs start
else
    echo 'External Redis selected; existing endpoints will be used.'
fi
echo 'Starting configured services. Local Redis containers persist until explicitly stopped.'
exec node scripts/workspace-runtime.cjs