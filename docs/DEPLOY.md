# Deploying Fridge Door to Cloudflare

This guide takes a fresh Cloudflare account to a running app: production on a custom domain and an
optional staging copy on workers.dev. All commands run from the repository root.

## 0. Prerequisites

- A Cloudflare account. The Workers free plan is enough for D1, KV and workers.dev; R2 needs to be
  enabled once in the dashboard (it has a free tier, but asks for a payment method).
- Node 22 or newer and npm. Wrangler comes with `npm ci`, so no global install is needed.
- At least one login provider: a Google Cloud project or a GitHub account for the OAuth app.
- Optional: an Anthropic API key for AI link import and ingredient classification.
- Optional: a domain whose DNS zone is on the same Cloudflare account.

Try it locally first (see "Local development" in the README): it needs none of the above except
Node.

### Before you fork

- Users: the app has exactly two fixed users, `max` and `nadine` (`USERS` in
  `shared/constants.ts`). Rename them there and in `LOGINS` if you like; the ids are stored on
  ratings, comments and revisions, so do it before you have data.
- The header links to this repository (`src/components/Header.tsx`); point it at your fork or drop it.
- Migrations 0006 and 0007 were data migrations for the original library (tag renames, diet tags
  by recipe id). On a fresh database they find nothing to change, so keep them in the sequence.

`wrangler.jsonc` holds your account's ids and `LOGINS` and is gitignored. You create it from
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

| key                           | value                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `routes[0].pattern`           | your domain, e.g. `recipes.example.com` (see step 9)                                               |
| `vars.MCP_RESOURCE`           | `https://<your domain>/mcp`. MCP tokens are bound to this exact URL                                |
| `kv_namespaces[0].id`         | the KV id from step 1                                                                              |
| `d1_databases[0].database_id` | the D1 id from step 1                                                                              |
| `r2_buckets[0].bucket_name`   | the bucket name, if you chose another one                                                          |
| `env.stg.*`                   | the same for staging; `MCP_RESOURCE` is `https://fridge-door-stg.<your-subdomain>.workers.dev/mcp` |

Your workers.dev subdomain is shown in the dashboard under Workers & Pages.

Keep `compatibility_flags` as they are. `nodejs_compat` is needed by the MCP handler, and
`global_fetch_strictly_public` keeps the Worker's `fetch()` on the public internet, which matters
because link import and `set_cover_from_url` download URLs chosen by a user or a model.

Without a custom domain, set `"workers_dev": true` and remove `routes` at the top level. Production
then runs on `https://fridge-door.<your-subdomain>.workers.dev`, and that origin goes into
`MCP_RESOURCE` and the OAuth redirect URIs below.

## 3. Logins

The app has two fixed users, `max` and `nadine`. The `LOGINS` var in `wrangler.jsonc` decides who
may log in as whom, per environment, with one entry per person:

```jsonc
"LOGINS": {
  "max": { "google": "alice@example.com", "github": "1234567" },
  "nadine": { "google": "bob@example.com" }
}
```

- `google` is an email address. It compares lowercased, with `googlemail.com` treated as
  `gmail.com` and dots in gmail local parts ignored.
- `github` is the numeric user id as a string, not the login (logins can be renamed). A rejected
  GitHub login shows "GitHub user <login> (id <n>) is not allowed", which is a quick way to find the id.
- Either login may be left out. The keys must be `max` or `nadine`. An unknown user or field turns
  both providers off. A malformed key or the same login under both people turns that provider off.
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

| secret                                     | needed                                          | what                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                           | yes                                             | HMAC key for the session and OAuth state cookies. Rotating it logs everyone out                                                                                                                                                                                            |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google login                                | from step 4                                                                                                                                                                                                                                                                |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | for GitHub login                                | from step 4                                                                                                                                                                                                                                                                |
| `IMPORT_TOKEN`                             | for `npm run load-import` and the base backfill | bearer token accepted only on `PUT /api/import/:ref`, `PUT /api/recipes/:id/cover` and `PUT /api/catalogue/backfill`, acting as `max`                                                                                                                                      |
| `ANTHROPIC_API_KEY`                        | optional                                        | link import with Claude, and Claude Haiku for ingredient names the catalogue does not know. Without it, link import still works (schema.org Recipe data is mapped field by field, other pages become stubs) and unknown ingredients get a rule-based base in aisle "other" |

Production:

```sh
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put SESSION_SECRET -c wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID -c wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_ID -c wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.jsonc
npm run import-token -- prod     # generates IMPORT_TOKEN, sets it, keeps a copy (see below)
npx wrangler secret put ANTHROPIC_API_KEY -c wrangler.jsonc
```

`wrangler secret put` prompts for the value, or reads it from stdin (`< file`).

Cloudflare never shows a secret again, so `npm run import-token -- prod|stg` keeps the IMPORT_TOKEN
it generates as `IMPORT_TOKEN_PROD` / `IMPORT_TOKEN_STG` in `.env` (gitignored, mode 600). Rerun it
to rotate; the old token stops working.
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

The seed recipes carry no ingredient bases. Run the backfill (see "Ingredient bases" below) once
after deploying, or they get bases the next time each is saved.

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

## Updating a deployment

```sh
git pull
npm ci
npm test
npm run db:migrate:stg && npm run deploy:stg    # try staging first
npm run db:migrate:remote && npm run deploy     # then production
```

Always apply migrations before deploying the Worker that needs them. The migrations so far keep
the schema backward compatible, so a Worker that is one version behind keeps working against it. Before a
risky migration, note a D1 restore point with `npx wrangler d1 time-travel info <database> -c wrangler.jsonc`.

Clients update themselves: the service worker fetches the new build and the next page load uses
it. Older clients and their offline queues keep syncing, since new fields are optional.

## Renaming storage

D1 databases and R2 buckets cannot be renamed. To move to a new name, copy the data into new
storage and point the Worker at it. This is how the old `recipes-spa` database and bucket became
`fridge-door` and `fridge-door-covers`:

1. Note a restore point and the row count of every table on the old database
   (`npx wrangler d1 time-travel info <old>`).
2. Create the new database and bucket (step 1 above), then copy every bucket object with its
   `contentType` and compare key, type and etag on both sides.
3. `npx wrangler d1 export <old> --remote --output dump.sql`, then
   `npx wrangler d1 execute <new> --remote --file dump.sql`. The dump includes `d1_migrations`, so
   `db:migrate:remote` has nothing left to apply. Compare row counts.
4. Put the new `database_name`, `database_id` and `bucket_name` in `wrangler.jsonc`, then `npm run deploy`.
5. Check that the old database's time-travel bookmark has not moved since the export, which means
   it took no writes during the switch. Then delete the old database and bucket.

The browser keeps its own local database (IndexedDB). `src/store/idb.ts` copies one under the old
name into the new name once and then deletes it, so offline edits that have not synced survive.

## Ingredient bases

Migrations 0008 and 0009 add the ingredient catalogue with a starter set and its change generation.
Later catalogue migrations (0010, 0011) move or add seed entries; they leave an aisle a person set
alone. After applying one, run the backfill so stored recipes and the current shopping list regroup.
Recipes saved before them (and the demo seed) have no bases until they are saved again. The backfill resolves every recipe's ingredients (Haiku for names
the catalogue does not know, when `ANTHROPIC_API_KEY` is set) and writes only the bases, without a
revision and without changing `updated_at`:

```sh
npm run backfill -- prod    # or stg; walks every page with the stored token
```

It is idempotent: rerun it after a key was added or the credits were topped up, and it converges on
the new answers. The first request (no cursor) also places every live shopping row again and writes the ones whose
base or aisle moved, with a newer `updated_at` so phones pick them up. It answers
`{ recipes, updated, shopping, items, unknown, nextCursor }`. Each request processes at most 50 recipes; the script follows `nextCursor` until it is null. Rerun without a cursor after enabling AI or correcting aliases. `unknown` counts the names that
kept a rule-based base. Review what the model added with the MCP tool `list_ingredients` (origin
`auto`) and correct it with `set_ingredient`.

## Loading recipes in bulk

`scripts/load-import.ts` loads import records (the format in `import/NORMALIZE.md`) into a running
deployment, using `IMPORT_TOKEN`:

```sh
RECIPES_IMPORT_TOKEN="$(grep ^IMPORT_TOKEN_PROD= .env | cut -d= -f2-)" npm run load-import -- https://<your domain> <records dir> <images dir> [id ...]
```

It is idempotent: an unchanged record writes nothing, and a cover uploads only when its content
changed.
