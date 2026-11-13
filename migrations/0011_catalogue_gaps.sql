-- Names on the prod recipes that resolved to no base after 0010 and that no descriptor covers.
INSERT OR IGNORE INTO ingredient_aliases (alias, base)
  SELECT key, value FROM json_each('{
    "just-off-boil water": "water", "pasta water": "water", "parchment paper": "baking paper",
    "tamari": "soy sauce", "canned coconut milk": "coconut milk", "shiitake mushroom": "mushroom",
    "king oyster mushroom": "mushroom", "new potato": "potato", "light miso": "miso paste"
  }');
