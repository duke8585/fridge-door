#!/usr/bin/env bash
# Runs PUT /api/catalogue/backfill on one environment, page by page, with the token that
# scripts/import-token.sh stored. Run it after a catalogue migration. Prints each page's result.
#   scripts/backfill.sh prod|stg
# The URL comes from that environment's MCP_RESOURCE in wrangler.jsonc; override with BASE_URL.
set -euo pipefail

env="${1:-}"
case "$env" in
  prod) nth=1 ;;
  stg) nth=2 ;;
  *) echo "usage: $0 prod|stg" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
file="${FRIDGE_DOOR_CONFIG:-$HOME/.config/fridge-door}/import-token-$env"
[ -s "$file" ] || { echo "$file is missing; run scripts/import-token.sh $env first" >&2; exit 1; }
base="${BASE_URL:-$(grep -o '"MCP_RESOURCE": *"[^"]*"' "$root/wrangler.jsonc" | sed -n "${nth}p" | sed 's/.*"\(https[^"]*\)\/mcp"/\1/')}"
case "$base" in https://*) ;; *) echo "no URL for $env in wrangler.jsonc; set BASE_URL" >&2; exit 1 ;; esac

cursor=""
while :; do
  url="$base/api/catalogue/backfill"
  [ -n "$cursor" ] && url="$url?cursor=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$cursor")"
  page="$(curl -fsS -X PUT -H "Authorization: Bearer $(cat "$file")" "$url")"
  echo "$page"
  cursor="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).nextCursor ?? "")' "$page")"
  [ -n "$cursor" ] || break
done
