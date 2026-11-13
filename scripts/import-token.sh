#!/usr/bin/env bash
# Generates a new IMPORT_TOKEN for one environment, stores it outside the repo and sets it as the
# Worker secret. The old token stops working. Nothing is printed.
#   scripts/import-token.sh prod|stg
# The token lands in ${FRIDGE_DOOR_CONFIG:-~/.config/fridge-door}/import-token-<env> (mode 600);
# scripts/backfill.sh and `npm run load-import` (RECIPES_IMPORT_TOKEN="$(cat <file>)") read it there.
set -euo pipefail

env="${1:-}"
case "$env" in
  prod) envflag=() ;;
  stg) envflag=(--env stg) ;;
  *) echo "usage: $0 prod|stg" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${FRIDGE_DOOR_CONFIG:-$HOME/.config/fridge-door}"
file="$dir/import-token-$env"
mkdir -p "$dir"
chmod 700 "$dir"
(umask 077 && openssl rand -base64 32 | tr -d '\n' > "$file.new")
(cd "$root" && npx wrangler secret put IMPORT_TOKEN -c wrangler.jsonc "${envflag[@]}" < "$file.new")
mv "$file.new" "$file"
echo "IMPORT_TOKEN for $env set; stored in $file" >&2
