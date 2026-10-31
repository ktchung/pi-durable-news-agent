#!/bin/sh
set -eu
role="${1:-api}"
scripts_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "${DNA_APP_ROOT:-/app}"
node "$scripts_dir/preflight.mjs" "$role"
case "$role" in
  api) exec node --import tsx apps/dna-server-api/src/main.ts ;;
  hub) exec node --import tsx apps/dna-client-browser/hub/src/main.ts ;;
  ticker) exec node "$scripts_dir/ticker.mjs" ;;
  bridge) exec node "$scripts_dir/bridge.mjs" ;;
  auth-login|auth-status|auth-logout)
    exec node --import tsx apps/shared/packages/durable-agent/src/codex-login.ts "$role" ;;
  *) exit 64 ;;
esac
