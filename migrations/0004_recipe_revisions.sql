-- Version history of recipe content + tags (not cover, focus, ratings or comments).
-- `snapshot` is the content AFTER the change, built in SQL from the recipes row (worker/repo.ts).
-- 'baseline' = the content before the first recorded change (author unknown, NULL).
CREATE TABLE recipe_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL,
  author     TEXT,
  source     TEXT NOT NULL CHECK (source IN ('baseline', 'editor', 'tags', 'import', 'restore', 'mcp')),
  created_at TEXT NOT NULL
);
CREATE INDEX recipe_revisions_recipe ON recipe_revisions(recipe_id, id);
