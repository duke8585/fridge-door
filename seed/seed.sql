-- Seed: 4 recipes covering the brief's edge cases.
--   pancakes      : yield, tsp/tbsp, unscalable item (salt, a pinch)
--   aglio-e-olio  : ranges (garlic 4-6 cloves, oil 4-5 tbsp, chili 0.5-1 tsp)
--   lemon-drizzle : two sections (cake + drizzle), yield "1 loaf"
--   tomato-sauce  : NO yield (scale by factor), unscalable basil/salt
-- Idempotent: INSERT OR IGNORE, so `npm run dev` (predev) can re-run it on every start
-- without failing or duplicating, and without touching rows you edited. `npm run db:reset` wipes first.

INSERT OR IGNORE INTO recipes (id, title, yield_amount, yield_unit, sections_json, steps_md, notes_md, source_url, tags_json, created_at, updated_at) VALUES
('pancakes', 'Fluffy pancakes', 4, 'servings',
 '[{"ingredients":[{"item":"flour","qty":200,"unit":"g"},{"item":"milk","qty":300,"unit":"ml"},{"item":"eggs","qty":2,"unit":"piece"},{"item":"butter","qty":30,"unit":"g","prep":"melted"},{"item":"sugar","qty":1,"unit":"tbsp"},{"item":"baking powder","qty":2,"unit":"tsp"},{"item":"salt","note":"a pinch"}]}]',
 '1. Whisk flour, sugar, baking powder and salt in a large bowl.
2. Whisk milk, eggs and melted butter in a jug.
3. Pour the wet into the dry and stir until *just* combined - a few lumps are fine.
4. Rest the batter for 5 minutes.
5. Cook ladlefuls in a lightly buttered pan over medium heat until bubbles form, flip, cook 1 more minute.',
 'Keep cooked pancakes warm in a 100 °C oven. Great with **blueberries** and maple syrup.',
 NULL, '["course:breakfast"]', '2026-11-01T08:00:00.000Z', '2026-11-01T08:00:00.000Z'),

('aglio-e-olio', 'Spaghetti aglio e olio', 2, 'servings',
 '[{"ingredients":[{"item":"spaghetti","qty":200,"unit":"g"},{"item":"garlic","qty":4,"qtyMax":6,"unit":"clove","prep":"thinly sliced"},{"item":"olive oil","qty":4,"qtyMax":5,"unit":"tbsp"},{"item":"chili flakes","qty":0.5,"qtyMax":1,"unit":"tsp"},{"item":"parsley","prep":"chopped","note":"a handful"},{"item":"salt","note":"to taste"}]}]',
 '1. Cook the spaghetti in well salted water until al dente. Keep a cup of pasta water.
2. Meanwhile warm the oil in a large pan on low heat, add garlic and chili, and cook gently until the garlic is pale golden.
3. Toss the drained pasta in the pan with a splash of pasta water until glossy.
4. Stir in the parsley and season.',
 'Do not let the garlic brown - it turns bitter.',
 'https://en.wikipedia.org/wiki/Spaghetti_aglio_e_olio', '["course:main","cuisine:italian","diet:vegan"]', '2026-11-02T18:00:00.000Z', '2026-11-02T18:00:00.000Z'),

('lemon-drizzle', 'Lemon drizzle cake', 1, 'loaf (24 cm)',
 '[{"title":"For the cake","ingredients":[{"item":"butter","qty":225,"unit":"g","prep":"softened"},{"item":"caster sugar","qty":225,"unit":"g"},{"item":"eggs","qty":4,"unit":"piece"},{"item":"self-raising flour","qty":225,"unit":"g"},{"item":"lemon","qty":1,"unit":"piece","prep":"zest only"}]},{"title":"For the drizzle","ingredients":[{"item":"lemon","qty":1.5,"unit":"piece","prep":"juiced"},{"item":"granulated sugar","qty":85,"unit":"g"}]}]',
 '1. Heat the oven to 180 °C (160 °C fan). Line a 24 cm loaf tin.
2. Beat butter and caster sugar until pale, then beat in the eggs one at a time.
3. Fold in the flour and lemon zest. Spoon into the tin.
4. Bake 45-50 minutes until a skewer comes out clean.
5. Mix lemon juice and granulated sugar, and pour over the warm cake. Cool in the tin.',
 'Prick the warm cake all over with a skewer before drizzling.',
 NULL, '["course:baking","course:dessert","method:oven"]', '2026-11-03T15:00:00.000Z', '2026-11-03T15:00:00.000Z'),

('tomato-sauce', 'Basic tomato sauce', NULL, NULL,
 '[{"ingredients":[{"item":"canned tomatoes","qty":800,"unit":"g"},{"item":"onion","qty":1,"unit":"piece","prep":"finely chopped"},{"item":"garlic","qty":3,"unit":"clove","prep":"crushed"},{"item":"olive oil","qty":3,"unit":"tbsp"},{"item":"basil","note":"a few leaves"},{"item":"salt","note":"to taste"}]}]',
 '- Soften the onion in the oil for 10 minutes.
- Add garlic, cook 1 minute.
- Add tomatoes, simmer 20-30 minutes until thick.
- Season, tear in the basil.',
 'Freezes well. Double it and freeze in 400 g portions.',
 NULL, '["course:sauce","diet:vegan","method:batch"]', '2026-11-04T12:00:00.000Z', '2026-11-04T12:00:00.000Z');

INSERT OR IGNORE INTO ratings (recipe_id, user, stars, updated_at) VALUES
('pancakes', 'max', 5, '2026-11-05T09:00:00.000Z'),
('pancakes', 'partner', 4, '2026-11-05T09:00:00.000Z'),
('aglio-e-olio', 'max', 4, '2026-11-05T09:00:00.000Z'),
('lemon-drizzle', 'partner', 5, '2026-11-05T09:00:00.000Z');

INSERT OR IGNORE INTO comments (id, recipe_id, user, body_md, created_at, updated_at) VALUES
('c-seed-1', 'pancakes', 'partner', 'Used **buttermilk** instead of milk - even fluffier.', '2026-11-05T09:10:00.000Z', '2026-11-05T09:10:00.000Z'),
('c-seed-2', 'aglio-e-olio', 'max', 'Add lemon zest at the end.', '2026-11-05T19:00:00.000Z', '2026-11-05T19:00:00.000Z');
