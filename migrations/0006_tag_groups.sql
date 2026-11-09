-- Tag groups: every tag becomes "group:value" (shared/tags.ts). Rewrites recipes.tags_json with the
-- legacy mapping (LEGACY_TAGS, and any other loose kebab tag -> list:<tag>, as upgradeTag in
-- shared/tags.ts; test/worker/tagMigration.test.ts keeps both equal)
-- and records the change in the history like any content write: a 'baseline' first for a recipe
-- without history, then a 'migration' revision (no author, the time it ran). updated_at is left
-- alone: renaming tags is no edit, so "Recently modified" keeps its order. Old snapshots stay as they were;
-- restoring one maps its tags (restoredContent in shared/revisions.ts).
--
-- A loose tag that is neither in the mapping nor a lowercase kebab word (so it cannot become a list)
-- stops the migration before anything is written ("CHECK constraint failed: unknown_tag_see_0006
-- IS NULL"). Find the loose tags with:
--   SELECT DISTINCT j.value FROM recipes, json_each(recipes.tags_json) j WHERE j.value NOT LIKE '%:%';
-- Statements are safe to run again after such a failure.

CREATE TABLE IF NOT EXISTS _tag_map (old TEXT PRIMARY KEY, new TEXT NOT NULL);
INSERT OR IGNORE INTO _tag_map (old, new) VALUES
  ('breakfast', 'course:breakfast'),
  ('main', 'course:main'),
  ('side', 'course:side'),
  ('salad', 'course:salad'),
  ('soup', 'course:soup'),
  ('snack', 'course:snack'),
  ('dessert', 'course:dessert'),
  ('baking', 'course:baking'),
  ('drink', 'course:drink'),
  ('sauce', 'course:sauce'),
  ('basics', 'course:basics'),
  ('oven', 'method:oven'),
  ('airfryer', 'method:airfryer'),
  ('instant-pot', 'method:instant-pot'),
  ('one-pot', 'method:one-pot'),
  ('no-cook', 'method:no-cook'),
  ('batch', 'method:batch'),
  ('indian', 'cuisine:indian'),
  ('italian', 'cuisine:italian'),
  ('korean', 'cuisine:korean'),
  ('thai', 'cuisine:thai'),
  ('japanese', 'cuisine:japanese'),
  ('laotian', 'cuisine:laotian'),
  ('cambodian', 'cuisine:cambodian'),
  ('middle-eastern', 'cuisine:middle-eastern'),
  ('mexican', 'cuisine:mexican'),
  ('german', 'cuisine:german'),
  ('other', 'cuisine:other'),
  ('vegan', 'diet:vegan'),
  ('stub', 'status:stub'),
  ('needs-method', 'todo:method'),
  ('next-up', 'list:next-up');

-- Every other loose kebab tag was an owner's list.
INSERT OR IGNORE INTO _tag_map (old, new)
  SELECT DISTINCT j.value, 'list:' || j.value FROM recipes r, json_each(r.tags_json) j
   WHERE j.value NOT LIKE '%:%' AND j.value <> '' AND length(j.value) <= 35
     AND j.value NOT GLOB '*[^a-z0-9-]*' AND j.value NOT GLOB '-*' AND j.value NOT GLOB '*-' AND j.value NOT GLOB '*--*';

CREATE TABLE IF NOT EXISTS _tag_guard (unknown_tag_see_0006 TEXT CHECK (unknown_tag_see_0006 IS NULL));
INSERT INTO _tag_guard (unknown_tag_see_0006)
  SELECT DISTINCT j.value FROM recipes r, json_each(r.tags_json) j
   WHERE j.value NOT IN (SELECT old FROM _tag_map) AND j.value NOT LIKE '%_:_%';
DROP TABLE _tag_guard;

-- 'migration' joins the allowed revision sources (SQLite cannot change a CHECK in place, see 0005).
CREATE TABLE recipe_revisions_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  snapshot   TEXT NOT NULL,
  author     TEXT,
  source     TEXT NOT NULL CHECK (source IN ('baseline', 'editor', 'tags', 'import', 'restore', 'mcp', 'url-import', 'migration')),
  created_at TEXT NOT NULL
);
INSERT INTO recipe_revisions_new (id, recipe_id, snapshot, author, source, created_at)
  SELECT id, recipe_id, snapshot, author, source, created_at FROM recipe_revisions;
DROP TABLE recipe_revisions;
ALTER TABLE recipe_revisions_new RENAME TO recipe_revisions;
CREATE INDEX recipe_revisions_recipe ON recipe_revisions(recipe_id, id);

-- The snapshot expression is SNAPSHOT in worker/repo.ts, so equal content gives equal text.
INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
  SELECT id, json_object('title', title,
           'yield', json(CASE WHEN yield_amount IS NULL THEN NULL ELSE json_object('amount', yield_amount, 'unit', yield_unit) END),
           'time', json(CASE WHEN time_total_min IS NULL THEN NULL ELSE json_object('total_min', time_total_min, 'active_min', time_active_min) END),
           'sections', json(sections_json), 'steps_md', steps_md, 'notes_md', notes_md, 'source_url', source_url, 'tags', json(tags_json)),
         NULL, 'baseline', updated_at
    FROM recipes r
   WHERE EXISTS (SELECT 1 FROM json_each(r.tags_json) j JOIN _tag_map m ON m.old = j.value)
     AND NOT EXISTS (SELECT 1 FROM recipe_revisions v WHERE v.recipe_id = r.id);

-- Mapped in place: order kept, a tag that maps onto one already there is not repeated.
UPDATE recipes
   SET tags_json = (SELECT json_group_array(tag) FROM (
                      SELECT COALESCE(m.new, j.value) AS tag, MIN(j.key) AS pos
                        FROM json_each(recipes.tags_json) j LEFT JOIN _tag_map m ON m.old = j.value
                       GROUP BY tag ORDER BY pos))
 WHERE EXISTS (SELECT 1 FROM json_each(recipes.tags_json) j JOIN _tag_map m ON m.old = j.value);

-- A 'migration' revision wherever the content now differs from the latest revision (only the
-- recipes just rewritten: every other recipe with history equals its latest revision).
INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
  SELECT id, snap, NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
    SELECT r.id, json_object('title', title,
             'yield', json(CASE WHEN yield_amount IS NULL THEN NULL ELSE json_object('amount', yield_amount, 'unit', yield_unit) END),
             'time', json(CASE WHEN time_total_min IS NULL THEN NULL ELSE json_object('total_min', time_total_min, 'active_min', time_active_min) END),
             'sections', json(sections_json), 'steps_md', steps_md, 'notes_md', notes_md, 'source_url', source_url, 'tags', json(tags_json)) AS snap
      FROM recipes r
     WHERE EXISTS (SELECT 1 FROM recipe_revisions v WHERE v.recipe_id = r.id)
  ) cur
   WHERE snap IS NOT (SELECT snapshot FROM recipe_revisions WHERE id = (SELECT MAX(id) FROM recipe_revisions WHERE recipe_id = cur.id));

DROP TABLE _tag_map;
