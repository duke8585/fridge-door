-- diet:vegan for the recipes that are vegan as written (classified by ingredients, 2026-11-09).
-- Left out on purpose: honey, egg/mie noodles, wontons, puff pastry, curry paste that may hold
-- shrimp, "ghee or oil", and protein powder of unknown kind. Ids missing on a database are skipped.
-- Writes history like 0006: a baseline where a recipe has none, then a 'migration' revision.
-- updated_at is not touched, so "Recently modified" keeps its order.

CREATE TABLE _vegan (id TEXT PRIMARY KEY);
INSERT INTO _vegan (id) VALUES
  ('acv-ice-cubes-for-glucose-control'),
  ('air-fryer-kidney-beans'),
  ('banana-bread-with-soy-protein'),
  ('banana-raspberry-bark'),
  ('bang-bang-tahini-salad'),
  ('beni-imo-pudding'),
  ('braised-fennel-with-white-beans-and-lemo'),
  ('broccoli-steak-with-beetroot-hummus'),
  ('brussels-sprouts-and-butternut-squash-wi'),
  ('coriander-oil-cubes'),
  ('creamy-cauliflower-cashew-soup'),
  ('creamy-courgette-and-green-bean-gnocchi'),
  ('crispy-eggplant-donburi'),
  ('cucumber-avocado-crispy-rice'),
  ('cucumber-za-atar-and-chopped-lemon-salad'),
  ('easy-aromatic-noodle-broth'),
  ('easy-lentil-patties'),
  ('farinata-chickpea-oven-bread'),
  ('glass-noodle-salad'),
  ('green-salad-with-peanut-dressing'),
  ('indian-spiced-grated-tofu-bowl'),
  ('insalata-di-limone-lemon-salad'),
  ('keto-buns'),
  ('keto-flaxseed-bread'),
  ('korean-smashed-cucumber-salad'),
  ('kung-pao-tofu'),
  ('max-s-mum-s-potato-salad'),
  ('miso-tantanmen'),
  ('no-bake-protein-brownies'),
  ('nutritional-yeast-specials'),
  ('nutty-pudding-longevity-protein'),
  ('okonomiyaki-variant'),
  ('peanut-tofu-satay'),
  ('protein-chia-pudding-with-cinnamon'),
  ('roasted-cauliflower-with-gochujang-sauce'),
  ('smoky-vegan-corn-chowder-with-potatoes'),
  ('socca'),
  ('super-veggie'),
  ('truffled-cauliflower-cheese-bake'),
  ('vegan-turkish-style-pasta'),
  ('vegan-banana-peanut-butter-protein-brown'),
  ('vegan-peanut-miso-ramen'),
  ('vegan-pecan-banana-cinnamon-chia-pudding'),
  ('winter-squash-and-wild-mushroom-curry'),
  ('avocado-and-citrus-ceviche');

INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
  SELECT id, json_object('title', title,
           'yield', json(CASE WHEN yield_amount IS NULL THEN NULL ELSE json_object('amount', yield_amount, 'unit', yield_unit) END),
           'time', json(CASE WHEN time_total_min IS NULL THEN NULL ELSE json_object('total_min', time_total_min, 'active_min', time_active_min) END),
           'sections', json(sections_json), 'steps_md', steps_md, 'notes_md', notes_md, 'source_url', source_url, 'tags', json(tags_json)),
         NULL, 'baseline', updated_at
    FROM recipes r
   WHERE id IN (SELECT id FROM _vegan)
     AND NOT EXISTS (SELECT 1 FROM json_each(r.tags_json) j WHERE j.value = 'diet:vegan')
     AND NOT EXISTS (SELECT 1 FROM recipe_revisions v WHERE v.recipe_id = r.id);

UPDATE recipes SET tags_json = json_insert(tags_json, '$[#]', 'diet:vegan')
 WHERE id IN (SELECT id FROM _vegan)
   AND NOT EXISTS (SELECT 1 FROM json_each(recipes.tags_json) j WHERE j.value = 'diet:vegan');

INSERT INTO recipe_revisions (recipe_id, snapshot, author, source, created_at)
  SELECT id, snap, NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
    SELECT r.id, json_object('title', title,
           'yield', json(CASE WHEN yield_amount IS NULL THEN NULL ELSE json_object('amount', yield_amount, 'unit', yield_unit) END),
           'time', json(CASE WHEN time_total_min IS NULL THEN NULL ELSE json_object('total_min', time_total_min, 'active_min', time_active_min) END),
           'sections', json(sections_json), 'steps_md', steps_md, 'notes_md', notes_md, 'source_url', source_url, 'tags', json(tags_json)) AS snap
      FROM recipes r WHERE id IN (SELECT id FROM _vegan)
  ) cur
   WHERE snap IS NOT (SELECT snapshot FROM recipe_revisions WHERE id = (SELECT MAX(id) FROM recipe_revisions WHERE recipe_id = cur.id));

DROP TABLE _vegan;
