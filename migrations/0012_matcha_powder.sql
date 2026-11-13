-- Recipes mean matcha powder, which is not shelved with drinks. Rename the base and keep "matcha"
-- as an alias. Skipped entirely when a person already put matcha into an aisle.
INSERT INTO ingredient_bases (base, aisle)
  SELECT 'matcha powder', 'baking' WHERE NOT EXISTS (SELECT 1 FROM ingredient_bases WHERE base = 'matcha' AND origin = 'user')
  ON CONFLICT(base) DO NOTHING;
UPDATE ingredient_aliases SET base = 'matcha powder'
  WHERE base = 'matcha' AND NOT EXISTS (SELECT 1 FROM ingredient_bases WHERE base = 'matcha' AND origin = 'user');
DELETE FROM ingredient_bases WHERE base = 'matcha' AND origin != 'user';
INSERT OR IGNORE INTO ingredient_aliases (alias, base)
  SELECT 'matcha', 'matcha powder' WHERE NOT EXISTS (SELECT 1 FROM ingredient_bases WHERE base = 'matcha');
