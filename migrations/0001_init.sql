-- Recipes: ingredients (sections) and tags as JSON on the row, as the brief allows.
CREATE TABLE recipes (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  yield_amount  REAL,
  yield_unit    TEXT,
  sections_json TEXT NOT NULL DEFAULT '[]',
  steps_md      TEXT NOT NULL DEFAULT '',
  notes_md      TEXT NOT NULL DEFAULT '',
  source_url    TEXT,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE ratings (
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user       TEXT NOT NULL,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, user)
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user       TEXT NOT NULL,
  body_md    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX comments_recipe ON comments(recipe_id, created_at);

-- Shopping list: one household list. `rev` is a server-assigned, monotonically
-- increasing change counter used as the polling cursor; `updated_at` is the
-- client write time used for last-write-wins. `deleted` = tombstone.
CREATE TABLE shopping_items (
  id           TEXT PRIMARY KEY,
  item         TEXT NOT NULL,
  qty          REAL,
  qty_max      REAL,
  unit         TEXT,
  recipe_id    TEXT,
  recipe_title TEXT,
  checked      INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  rev          INTEGER NOT NULL
);
CREATE INDEX shopping_rev ON shopping_items(rev);
