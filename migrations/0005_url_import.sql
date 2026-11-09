-- Import from a link: a new revision source and the per-user rate limit log.
-- SQLite cannot change a CHECK constraint in place, so recipe_revisions is rebuilt with the same
-- columns, rows and index; only 'url-import' is added to the allowed sources.
CREATE TABLE recipe_revisions_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL,
  author     TEXT,
  source     TEXT NOT NULL CHECK (source IN ('baseline', 'editor', 'tags', 'import', 'restore', 'mcp', 'url-import')),
  created_at TEXT NOT NULL
);
INSERT INTO recipe_revisions_new (id, recipe_id, snapshot, author, source, created_at)
  SELECT id, recipe_id, snapshot, author, source, created_at FROM recipe_revisions;
DROP TABLE recipe_revisions;
ALTER TABLE recipe_revisions_new RENAME TO recipe_revisions;
CREATE INDEX recipe_revisions_recipe ON recipe_revisions(recipe_id, id);

-- One row per URL import that reached the fetch step (POST /api/import-url): the per-user rate
-- limit, and the token usage of the model calls (NULL when no model ran) for estimating how long
-- the API credits last. Rows older than 90 days are deleted on insert.
CREATE TABLE url_import_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  model               TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER
);
CREATE INDEX url_import_log_user ON url_import_log(user, created_at);

-- Set when the Anthropic API said the credits are used up or the key is rejected, so imports skip
-- the model until `until` (an hour later); a top-up is picked up after that without a deploy.
CREATE TABLE ai_status (
  key    TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('credits_exhausted', 'key_rejected')),
  until  TEXT NOT NULL
);
