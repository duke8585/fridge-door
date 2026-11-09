#!/usr/bin/env bash
# Sets the production (top-level env) login secrets from files. Run before `npm run deploy`.
# Values are piped straight from the files into wrangler; nothing is printed.
# SESSION_SECRET is generated fresh (re-running this logs everyone out).
# Setting a secret creates a new version of the currently deployed code.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: GITHUB_CLIENT_ID_FILE=<file> GITHUB_CLIENT_SECRET_FILE=<file> \
       GOOGLE_CLIENT_ID_FILE=<file> GOOGLE_CLIENT_SECRET_FILE=<file> \
       IMPORT_TOKEN_FILE=<file> scripts/set-prod-secrets.sh

Each variable names a file holding one secret value. Sets GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and IMPORT_TOKEN on the top-level Worker of wrangler.jsonc,
and generates a new SESSION_SECRET.
EOF
  exit 2
}

NAMES=(GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET IMPORT_TOKEN)
for name in "${NAMES[@]}"; do
  var="${name}_FILE"
  file="${!var:-}"
  [ -n "$file" ] || { echo "$var is not set" >&2; usage; }
  [ -s "$file" ] || { echo "$var: $file is missing or empty" >&2; exit 1; }
done

root="$(cd "$(dirname "$0")/.." && pwd)"
# The secret files are opened in the caller's directory, wrangler runs in the repo root.
put() { (cd "$root" && npx wrangler secret put "$1" -c wrangler.jsonc); }

for name in "${NAMES[@]}"; do
  var="${name}_FILE"
  put "$name" < "${!var}"
done
openssl rand -base64 32 | tr -d '\n' | put SESSION_SECRET

(cd "$root" && npx wrangler secret list -c wrangler.jsonc)
