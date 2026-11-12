-- Catalogue follow-up: the "home" aisle (water, ice), frozen fruit, sweeteners, and a few pantry
-- gaps. Bases are upserted so an existing seed entry moves aisle, but a base a person moved
-- (origin 'user') stays where they put it. Aliases never overwrite an existing one.
INSERT INTO ingredient_bases (base, aisle)
  SELECT b.value, a.key FROM json_each('{
    "home": ["water", "ice"],
    "frozen": ["frozen blueberry", "frozen raspberry", "frozen strawberry", "frozen mango"],
    "oils-sauces": ["stevia", "erythritol", "sweetener"],
    "international": ["wakame"],
    "spices": ["dried basil", "dried rosemary", "dried mint", "dried dill"],
    "dairy": ["margarine", "skyr"],
    "meat-fish": ["turkey"]
  }') a, json_each(a.value) b WHERE true
  ON CONFLICT(base) DO UPDATE SET aisle = excluded.aisle, origin = 'seed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE ingredient_bases.origin != 'user';

INSERT OR IGNORE INTO ingredient_aliases (alias, base)
  SELECT key, value FROM json_each('{
    "tap water": "water", "ice water": "water", "ice cube": "ice",
    "frozen mixed berry": "frozen berry", "stevia powder": "stevia",
    "kalamata olive": "olive", "miso": "miso paste", "silken tofu": "tofu", "firm tofu": "tofu",
    "self-raising flour": "flour", "dried wakame": "wakame",
    "flour tortilla": "tortilla", "corn tortilla": "tortilla", "mayo": "mayonnaise", "pita bread": "pita",
    "vegetable stock cube": "vegetable stock", "chicken stock cube": "chicken stock", "quick oats": "oats"
  }');
