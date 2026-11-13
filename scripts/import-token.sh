#!/usr/bin/env bash
# Generates a new IMPORT_TOKEN for one environment, sets it as the Worker secret and keeps a copy
# as IMPORT_TOKEN_<ENV> in the repo's .env (gitignored, mode 600). The old token stops working.
# Nothing is printed.
#   scripts/import-token.sh prod|stg
set -euo pipefail

env="${1:-}"
case "$env" in
  prod) envflag=() ;;
  stg) envflag=(--env stg) ;;
  *) echo "usage: $0 prod|stg" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
envfile="$root/.env"
key="IMPORT_TOKEN_$(echo "$env" | tr a-z A-Z)"
token="$(openssl rand -base64 32 | tr -d '\n')"
(cd "$root" && printf %s "$token" | npx wrangler secret put IMPORT_TOKEN -c wrangler.jsonc ${envflag[@]+"${envflag[@]}"})
(
  umask 077
  { [ -f "$envfile" ] && grep -v "^$key=" "$envfile" || true; echo "$key=$token"; } > "$envfile.new"
)
mv "$envfile.new" "$envfile"
echo "IMPORT_TOKEN for $env set; stored as $key in $envfile" >&2
