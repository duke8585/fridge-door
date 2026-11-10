-- Seed: 10 demo recipes. The first four cover the scaling edge cases:
--   pancakes      : yield, tsp/tbsp, unscalable item (salt, a pinch)
--   aglio-e-olio  : ranges (garlic 4-6 cloves, oil 4-5 tbsp, chili 0.5-1 tsp)
--   lemon-drizzle : two sections (cake + drizzle), yield "1 loaf"
--   tomato-sauce  : NO yield (scale by factor), unscalable basil/salt
-- The other six fill out the list, filters and shopping aisles.
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

INSERT OR IGNORE INTO recipes (id, title, yield_amount, yield_unit, sections_json, steps_md, notes_md, source_url, tags_json, created_at, updated_at) VALUES
('shakshuka', 'Shakshuka', 2, 'servings',
 '[{"ingredients":[{"item":"eggs","qty":4,"unit":"piece"},{"item":"canned tomatoes","qty":400,"unit":"g"},{"item":"red bell pepper","qty":1,"unit":"piece","prep":"sliced"},{"item":"onion","qty":1,"unit":"piece","prep":"sliced"},{"item":"garlic","qty":2,"unit":"clove","prep":"crushed"},{"item":"cumin","qty":1,"unit":"tsp"},{"item":"smoked paprika","qty":1,"unit":"tsp"},{"item":"feta","qty":50,"unit":"g","prep":"crumbled"},{"item":"olive oil","qty":2,"unit":"tbsp"},{"item":"bread","note":"to serve"}]}]',
 '1. Soften onion and pepper in the oil for 8 minutes.
2. Add garlic and spices, cook 1 minute, then the tomatoes. Simmer 10 minutes.
3. Make 4 hollows, crack in the eggs, cover and cook until the whites set.
4. Scatter over the feta and serve with bread.',
 '', NULL, '["course:breakfast","cuisine:middle-eastern","diet:vegetarian","method:one-pot"]', '2026-11-05T10:00:00.000Z', '2026-11-05T10:00:00.000Z'),

('chickpea-curry', 'Chickpea and spinach curry', 4, 'servings',
 '[{"ingredients":[{"item":"chickpeas","qty":480,"unit":"g","prep":"drained"},{"item":"coconut milk","qty":400,"unit":"ml"},{"item":"spinach","qty":150,"unit":"g"},{"item":"onion","qty":1,"unit":"piece","prep":"chopped"},{"item":"ginger","prep":"grated","note":"a thumb-sized piece"},{"item":"garlic","qty":3,"unit":"clove","prep":"crushed"},{"item":"curry powder","qty":2,"unit":"tbsp"},{"item":"rice","qty":300,"unit":"g"},{"item":"lime","qty":1,"unit":"piece"}]}]',
 '1. Cook the rice.
2. Fry the onion until soft, add ginger, garlic and curry powder for 1 minute.
3. Add chickpeas and coconut milk, simmer 15 minutes.
4. Stir in the spinach until wilted. Finish with lime juice.',
 'Even better the next day.', NULL, '["course:main","cuisine:indian","diet:vegan","method:one-pot"]', '2026-11-06T18:30:00.000Z', '2026-11-06T18:30:00.000Z'),

('greek-salad', 'Greek salad', 2, 'servings',
 '[{"ingredients":[{"item":"tomatoes","qty":4,"unit":"piece","prep":"in wedges"},{"item":"cucumber","qty":1,"unit":"piece","prep":"in chunks"},{"item":"red onion","qty":0.5,"unit":"piece","prep":"thinly sliced"},{"item":"feta","qty":200,"unit":"g"},{"item":"kalamata olives","qty":80,"unit":"g"},{"item":"dried oregano","qty":1,"unit":"tsp"},{"item":"olive oil","qty":3,"unit":"tbsp"}]}]',
 '1. Put the vegetables and olives in a bowl.
2. Lay the feta on top as one slab.
3. Sprinkle with oregano, pour over the oil and season.',
 '', NULL, '["course:salad","diet:vegetarian","method:no-cook"]', '2026-11-07T12:30:00.000Z', '2026-11-07T12:30:00.000Z'),

('overnight-oats', 'Apple cinnamon overnight oats', 2, 'portions',
 '[{"ingredients":[{"item":"rolled oats","qty":100,"unit":"g"},{"item":"oat milk","qty":250,"unit":"ml"},{"item":"apple","qty":1,"unit":"piece","prep":"grated"},{"item":"cinnamon","qty":1,"unit":"tsp"},{"item":"maple syrup","qty":1,"unit":"tbsp"},{"item":"walnuts","qty":30,"unit":"g","prep":"chopped"}]}]',
 '1. Mix oats, milk, apple, cinnamon and maple syrup.
2. Divide between two jars and chill overnight.
3. Top with walnuts.',
 '', NULL, '["course:breakfast","diet:vegan","method:no-cook"]', '2026-11-08T07:30:00.000Z', '2026-11-08T07:30:00.000Z'),

('banana-bread', 'Banana bread', 1, 'loaf',
 '[{"ingredients":[{"item":"bananas","qty":3,"unit":"piece","prep":"very ripe, mashed"},{"item":"flour","qty":250,"unit":"g"},{"item":"brown sugar","qty":100,"unit":"g"},{"item":"butter","qty":75,"unit":"g","prep":"melted"},{"item":"eggs","qty":2,"unit":"piece"},{"item":"baking soda","qty":1,"unit":"tsp"},{"item":"salt","note":"a pinch"}]}]',
 '1. Heat the oven to 175 °C. Line a loaf tin.
2. Mix bananas, butter, sugar and eggs.
3. Fold in flour, baking soda and salt.
4. Bake 55-60 minutes.',
 '', NULL, '["course:baking","method:oven"]', '2026-11-08T15:00:00.000Z', '2026-11-08T15:00:00.000Z'),

('miso-soup', 'Quick miso soup', 2, 'bowls',
 '[{"ingredients":[{"item":"water","qty":700,"unit":"ml"},{"item":"white miso","qty":3,"unit":"tbsp"},{"item":"silken tofu","qty":150,"unit":"g","prep":"cubed"},{"item":"spring onions","qty":2,"unit":"piece","prep":"sliced"},{"item":"dried wakame","qty":1,"unit":"tbsp"}]}]',
 '1. Bring the water to a simmer with the wakame.
2. Add the tofu and warm through.
3. Off the heat, whisk in the miso. Top with spring onion.',
 'Never boil the miso.', NULL, '["course:soup","cuisine:japanese","diet:vegan"]', '2026-11-09T19:00:00.000Z', '2026-11-09T19:00:00.000Z');

INSERT OR IGNORE INTO ratings (recipe_id, user, stars, updated_at) VALUES
('shakshuka', 'max', 5, '2026-11-09T09:00:00.000Z'),
('shakshuka', 'partner', 5, '2026-11-09T09:00:00.000Z'),
('chickpea-curry', 'partner', 4, '2026-11-09T09:00:00.000Z'),
('banana-bread', 'max', 4, '2026-11-09T09:00:00.000Z');
