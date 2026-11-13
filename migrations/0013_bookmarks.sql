-- Per-person bookmarks, like ratings: a tap is not a content edit, so it never touches recipes.updated_at or makes a revision.
CREATE TABLE bookmarks (
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, user)
);
