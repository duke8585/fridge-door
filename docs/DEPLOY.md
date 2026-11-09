# Deploying Fridge Door to Cloudflare

This guide takes a fresh Cloudflare account to a running app: production on a custom domain and an
optional staging copy on workers.dev. All commands run from the repository root.

`wrangler.jsonc` holds your account's ids and allowlists and is gitignored. You create it from
`wrangler.example.jsonc` in step 2. The top level of that file is production, `env.stg` is
staging. Wrangler does not inherit vars or bindings into an env, so `env.stg` repeats all of them.

## 1. Create the storage

```sh
npm ci
npx wrangler login

npx wrangler d1 create fridge-door                 # prints the database_id
npx wrangler r2 bucket create fridge-door-covers
npx wrangler kv namespace create fridge-door-oauth  # prints the KV id
```

R2 must be enabled on the account once (dashboard, R2) before the bucket can be created.

For staging, create a second set:

```sh
npx wrangler d1 create fridge-door-stg
npx wrangler r2 bucket create fridge-door-stg-covers
npx wrangler kv namespace create fridge-door-stg-oauth
```

## 2. Fill in wrangler.jsonc

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

Replace every `<...>` value:

| key | value |
|---|---|
| `routes[0].pattern` | your domain, e.g. `recipes.example.com` (see step 9) |
| `vars.MCP_RESOURCE` | `https://<your domain>/mcp`. MCP tokens are bound to this exact URL |
| `kv_namespaces[0].id` | the KV id from step 1 |
| `d1_databases[0].database_id` | the D1 id from step 1 |
| `r2_buckets[0].bucket_name` | the bucket name, if you chose another one |
| `env.stg.*` | the same for staging; `MCP_RESOURCE` is `https://fridge-door-stg.<your-subdomain>.workers.dev/mcp` |

Your workers.dev subdomain is shown in the dashboard under Workers & Pages.

Keep `compatibility_flags` as they are. `nodejs_compat` is needed by the MCP handler, and
`global_fetch_strictly_public` keeps the Worker's `fetch()` on the public internet, which matters
because link import and `set_cover_from_url` download URLs chosen by a user or a model.

Without a custom domain, set `"workers_dev": true` and remove `routes` at the top level. Production
then runs on `https://fridge-door.<your-subdomain>.workers.dev`, and that origin goes into
`MCP_RESOURCE` and the OAuth redirect URIs below.

## 3. Allowlists

The app has two fixed users, `max` and `partner`. Two vars in `wrangler.jsonc` decide who may log in
as whom, per environment:

```jsonc
"ALLOWED_GOOGLE": "{\"alice@example.com\":\"max\",\"bob@example.com\":\"partner\"}",
"ALLOWED_GITHUB": "{\"1234567\":\"max\"}",
```

- Google keys are email addresses. They compare lowercased, with `googlemail.com` treated as
  `gmail.com` and dots in gmail local parts ignored.
- GitHub keys are numeric user ids, not logins (logins can be renamed). A rejected GitHub login
  shows "GitHub user <login> (id <n>) is not allowed", which is a quick way to find the id.
- Values must be `max` or `partner`. Empty or invalid JSON, an unknown user or a malformed key
  turns that provider off: nobody gets in with it.
- These are plain vars, not secrets. Removing someone does not end a session they already have;
  rotate `SESSION_SECRET` for that.

## 4. OAuth apps

Login needs at least one provider. The redirect URI is built from the request origin:
`https://<host>/auth/google/callback` and `https://<host>/auth/github/callback`.

**Google.** In Google Cloud Console, configure the OAuth consent screen, then create an OAuth
client ID of type "Web application". Add an authorized redirect URI for every environment:

```
https://<your domain>/auth/google/callback
https://fridge-door-stg.<your-subdomain>.workers.dev/auth/google/callback
```

The app asks for the scopes `openid email` and requires a verified email.

**GitHub.** In GitHub, Settings, Developer settings, OAuth Apps, create a new OAuth App with:

- Homepage URL: `https://<your domain>`
- Authorization callback URL: `https://<your domain>/auth/github/callback`

A GitHub OAuth App has a single callback URL, so create a second app for staging with
`https://fridge-door-stg.<your-subdomain>.workers.dev/auth/github/callback`. The app asks for the
`read:user` scope and uses the token once to read the numeric user id.

## 5. Secrets

Secrets are set per environment and never live in the repository.

| secret | needed | what |
|---|---|---|
| `SESSION_SECRET` | yes | HMAC key for the session and OAuth state cookies. Rotating it logs everyone out |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google login | from step 4 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for GitHub login | from step 4 |
| `IMPORT_TOKEN` | for `npm run load-import` | bearer token accepted only on `PUT /api/import/:ref` and `PUT /api/recipes/:id/cover`, acting as `max` |
| `ANTHROPIC_API_KEY` | optional | link import with Claude. Without it, link import still works: schema.org Recipe data is mapped field by field, other pages become stubs |

Production:

```sh
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put SESSION_SECRET -c wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID -c wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_ID -c wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.jsonc
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put IMPORT_TOKEN -c wrangler.jsonc
npx wrangler secret put ANTHROPIC_API_KEY -c wrangler.jsonc
```

`wrangler secret put` prompts for the value, or reads it from stdin (`< file`).
`scripts/set-prod-secrets.sh` does the same for production from files, without printing anything:

```sh
GITHUB_CLIENT_ID_FILE=... GITHUB_CLIENT_SECRET_FILE=... \
GOOGLE_CLIENT_ID_FILE=... GOOGLE_CLIENT_SECRET_FILE=... \
IMPORT_TOKEN_FILE=... scripts/set-prod-secrets.sh
```

Staging: the same commands with `--env stg`, e.g.
`npx wrangler secret put GOOGLE_CLIENT_ID --env stg -c wrangler.jsonc`.

The link import is rate limited to 20 imports per user per hour. When the API reports exhausted
credits or a rejected key, the app stops calling it for an hour and imports without AI meanwhile.

## 6. Migrations

```sh
npm run db:migrate:remote   # production
npm run db:migrate:stg      # staging
```

D1 records applied migrations by file name, so rerunning only applies new ones.

## 7. Demo data (optional)

```sh
npm run db:seed:remote      # production
npm run db:seed:stg         # staging
```

The seed adds four recipes with ratings and comments. It uses `INSERT OR IGNORE`, so rerunning it
neither fails nor overwrites edits.

## 8. Deploy

```sh
npm run deploy              # production
npm run deploy:stg          # staging
```

The Vite build picks the environment (`CLOUDFLARE_ENV=stg` for staging) and writes the resolved
config to `.wrangler/deploy/config.json`, which `wrangler deploy` then uses. The `db:*` scripts
pass `-c wrangler.jsonc` and do not depend on a build.

Check it: open the site, log in, and create a recipe. Without a session, `/api/*` answers 401,
page loads redirect to `/login`, and only the manifest and icon are public.

## 9. Custom domain

The top level of `wrangler.example.jsonc` serves production on a Cloudflare custom domain:

```jsonc
"workers_dev": false,
"routes": [{ "pattern": "recipes.example.com", "custom_domain": true }],
```

The domain's zone must be on the same Cloudflare account. `wrangler deploy` creates the DNS record
and certificate. `MCP_RESOURCE` and the OAuth redirect URIs must use the same host.

## 10. Connect Claude over MCP

The Worker is its own OAuth authorization server for `/mcp` (dynamic client registration, so no
client id or secret to copy).

- **claude.ai**: Settings, Connectors, Add custom connector, URL `https://<your domain>/mcp`.
- **Claude Code**: `claude mcp add --transport http fridge-door https://<your domain>/mcp`, then
  `/mcp` in a session to log in.

The browser opens `/authorize`, goes through the normal login if needed, and shows
"<client> wants to read and edit your Fridge Door recipes as <user>". The connection acts as the
person who approved. To connect as the other person, log in as them first. Access tokens last
1 hour, refresh tokens 30 days. There is no revoke UI; deleting the keys in the `OAUTH_KV`
namespace cuts every connection off.

Check the endpoint:

```sh
curl -s https://<your domain>/.well-known/oauth-protected-resource/mcp   # shows MCP_RESOURCE
curl -si -X POST https://<your domain>/mcp                               # 401 with WWW-Authenticate
```

Open the app once in the browser you approve in before adding the connector, so an older service
worker updates.

## 11. Sharing links from a phone

- **Android**: install the app (Chrome menu, Add to Home screen). The manifest registers a share
  target, so sharing a link to Fridge Door opens `/import` and starts the import.
- **iOS** has no web share target. A Shortcut does the same: "Show in Share Sheet" on, accepting
  URLs, Safari web pages and Text, with the actions Get URLs from Shortcut Input, Get Item from List
  (First Item), URL Encode, Text `https://<your domain>/import?url=` followed by the encoded URL,
  and Open URLs.

## Loading recipes in bulk

`scripts/load-import.ts` loads import records (the format in `import/NORMALIZE.md`) into a running
deployment, using `IMPORT_TOKEN`:

```sh
RECIPES_IMPORT_TOKEN=<IMPORT_TOKEN of that env> npm run load-import -- https://<your domain> <records dir> <images dir> [id ...]
```

It is idempotent: an unchanged record writes nothing, and a cover uploads only when its content
changed.
