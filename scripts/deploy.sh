#!/usr/bin/env bash
# Env-aware deploy. Selects the wrangler environment at BUILD time via
# CLOUDFLARE_ENV (read by @cloudflare/vite-plugin), so the generated
# dist/server/wrangler.json carries the env.<name> worker name, D1 and routes.
#
# .env (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) is force-loaded so it WINS
# over any ambient values the devcontainer/shell may have exported — otherwise
# the deploy can target the wrong Cloudflare account (D1 not found, code 10181).
set -euo pipefail

target="${1:-}"
case "$target" in
  staging | production) ;;
  *)
    echo "usage: scripts/deploy.sh <staging|production>" >&2
    exit 1
    ;;
esac

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export CLOUDFLARE_ENV="$target"
echo "Deploying to ${target} (account ...${CLOUDFLARE_ACCOUNT_ID: -6})"
exec bunx vinext deploy
