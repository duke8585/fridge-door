# CLAUDE.md

Account-specific notes (deploy permission, URLs, plan) go in the gitignored `CLAUDE.local.md`.

## Working style

- UI or layout choices: show 2-3 mobile mockups (A/B/C) with a recommendation, build after the
  user picks. Do not build and iterate on rejected variants.
- Mobile first. Phones (iOS Safari/Brave) are the main surface. Check WebKit at iPhone size, not
  only desktop Chromium. Size sheets with `dvh` or the visible viewport, never `vh`.
- Phone and desktop render differently (the shopping list is a page on phones, a side panel on
  wide screens). Fix and verify the surface the user is actually on.
- Labels say what tapping does. When a behavior is not obvious (shared, permanent), say so in the
  UI and in the README.
- A feature ships with its docs: README feature bullets and `docs/DEPLOY.md` in the same push.
- Users are config, not code: never name real people in tracked files.

## Commits

- Subject `Area: <the behavior that now holds>`, present tense, no type prefix, e.g.
  "Recipe list: always open on Modified, newest first".
- `npm run check` and `npm test` before committing. The pre-commit hook rejects unformatted staged
  files: `npm run fix`, stage again.

## Environment gotchas

- The sandbox blocks git commit/push, every wrangler call (`~/Library/Preferences/.wrangler`),
  the dev server port and reading `.env`. Run those unsandboxed.
- `$TMPDIR` differs inside and outside the sandbox. Use the absolute scratchpad path in scripts
  that cross both.
- `wrangler.jsonc` and `.env` are gitignored, so a new worktree lacks them. Copy both from the main
  checkout before deploying or running `import-token`/`backfill` there.
- "no such table" locally means a stale local D1: `npm run db:reset`.
- Browser checks: `npx vite --port 8788`, log in with `POST /auth/dev` (loopback only, needs
  `DEV_LOGIN=true` in `.dev.vars`). Keep playwright in the scratchpad, not as a repo dependency.
- After a deploy the PWA serves its cached copy first. Reload twice on the phone before concluding
  a fix did not land.
- Other sessions may deploy at the same time. Pull main and check
  `npx wrangler deployments list -c wrangler.jsonc` before deploying.

## Closing out ("done?")

Confirm and report each: tree clean, main pushed, stg and prod on HEAD with pending migrations
applied, `TODO.md` updated with deploy version ids (`stg <id>, prod <id>`), agent worktrees and
merged branches removed, any phone-only check listed for the user.
