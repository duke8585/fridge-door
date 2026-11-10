-- Ingredient catalogue (shared/catalogue.ts): canonical bases with their aisle, and aliases that map
-- other names onto a base. `origin` says who made an entry: 'seed' (this file), 'auto' (the model
-- classified an unknown item) or 'user' (a person moved it or set it), so the auto ones can be reviewed.
-- Bases and aliases are stored the way shared/catalogue.ts keys them: lowercase, no accents, last
-- word singular. test/worker/catalogue.test.ts checks that the seed keeps that form.
CREATE TABLE ingredient_bases (
  base       TEXT PRIMARY KEY,
  aisle      TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'auto', 'user')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ingredient_aliases (
  alias      TEXT PRIMARY KEY,
  base       TEXT NOT NULL REFERENCES ingredient_bases(base),
  origin     TEXT NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'auto', 'user')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ingredient_aliases_base ON ingredient_aliases(base);

-- Shopping items carry the base and aisle they were added with. NULL on rows from before this
-- migration and from older clients: the server fills them on the next write, the client groups
-- such rows by its own lookup meanwhile.
ALTER TABLE shopping_items ADD COLUMN base TEXT;
ALTER TABLE shopping_items ADD COLUMN aisle TEXT;

-- Household settings shared by both people, last-write-wins on updated_at. 'aisle_order' holds
-- the shopping list's aisle order as a JSON array; no row means the default order.
CREATE TABLE household_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Starter catalogue for a household cooking from this library in a German supermarket.
INSERT INTO ingredient_bases (base, aisle)
  SELECT b.value, a.key FROM json_each('{
    "produce": ["apple", "banana", "lemon", "lime", "orange", "pear", "grape", "strawberry", "raspberry", "blueberry",
      "mango", "pineapple", "avocado", "peach", "plum", "cherry", "kiwi", "pomegranate", "melon", "watermelon",
      "tomato", "cherry tomato", "potato", "sweet potato", "onion", "red onion", "shallot", "spring onion", "garlic",
      "ginger", "carrot", "celery", "celeriac", "leek", "fennel", "cucumber", "courgette", "aubergine", "bell pepper",
      "chili", "jalapeno", "mushroom", "spinach", "kale", "chard", "lettuce", "rocket", "cabbage", "red cabbage",
      "cauliflower", "broccoli", "green bean", "sugar snap pea", "pumpkin", "butternut squash", "beetroot", "radish",
      "asparagus", "parsnip", "kohlrabi", "pak choi", "bean sprout", "brussels sprout", "parsley", "coriander", "basil",
      "mint", "dill", "chive", "thyme", "rosemary", "sage", "lemongrass", "galangal"],
    "bakery": ["bread", "bread roll", "baguette", "burger bun", "toast", "pita", "naan", "sourdough bread"],
    "grains": ["pasta", "spaghetti", "penne", "fusilli", "tagliatelle", "lasagne sheet", "noodle", "egg noodle", "rice",
      "basmati rice", "risotto rice", "couscous", "bulgur", "quinoa", "oats", "polenta", "semolina", "red lentil",
      "lentil", "pearl barley", "breadcrumb", "muesli"],
    "baking": ["flour", "spelt flour", "wholemeal flour", "cornflour", "sugar", "brown sugar", "icing sugar",
      "vanilla sugar", "vanilla extract", "vanilla pod", "baking powder", "baking soda", "dry yeast", "cocoa powder",
      "dark chocolate", "chocolate chip", "almond", "ground almond", "walnut", "hazelnut", "cashew", "peanut", "pine nut",
      "pistachio", "pecan", "sesame seed", "sunflower seed", "pumpkin seed", "chia seed", "flaxseed",
      "desiccated coconut", "raisin", "date", "dried apricot", "dried cranberry", "honey", "maple syrup", "agave syrup",
      "gelatine"],
    "spices": ["salt", "black pepper", "white pepper", "cumin", "cumin seed", "paprika", "smoked paprika", "turmeric",
      "garam masala", "curry powder", "chili flake", "chili powder", "kashmiri chili powder", "cayenne pepper",
      "cinnamon", "cinnamon stick", "nutmeg", "clove", "cardamom", "star anise", "allspice", "bay leaf",
      "coriander seed", "ground coriander", "ground ginger", "fennel seed", "mustard seed", "fenugreek seed", "oregano",
      "dried thyme", "sumac", "garlic powder", "onion powder", "vegetable stock", "chicken stock"],
    "oils-sauces": ["olive oil", "vegetable oil", "sunflower oil", "rapeseed oil", "coconut oil", "vinegar",
      "white wine vinegar", "red wine vinegar", "balsamic vinegar", "apple cider vinegar", "mustard", "dijon mustard",
      "ketchup", "mayonnaise", "peanut butter", "worcestershire sauce", "hot sauce", "pesto"],
    "canned": ["chopped tomato", "passata", "tomato paste", "coconut milk", "coconut cream", "chickpea", "kidney bean",
      "black bean", "white bean", "corn", "tuna", "anchovy", "olive", "caper", "gherkin", "sun-dried tomato"],
    "international": ["soy sauce", "sesame oil", "rice vinegar", "mirin", "fish sauce", "oyster sauce", "hoisin sauce",
      "sriracha", "gochujang", "miso paste", "red curry paste", "green curry paste", "rice noodle", "rice paper",
      "sushi rice", "nori", "panko", "tamarind paste", "ghee", "tahini", "harissa", "toor dal", "chana dal", "moong dal",
      "urad dal", "kaffir lime leaf", "curry leaf", "sambal oelek", "tortilla", "kimchi", "asafoetida"],
    "sweets-snacks": ["tortilla chip", "cracker", "biscuit"],
    "drinks": ["water", "sparkling water", "white wine", "red wine", "beer", "orange juice", "apple juice", "coffee",
      "espresso", "tea", "matcha"],
    "dairy": ["milk", "butter", "cream", "sour cream", "creme fraiche", "yogurt", "greek yogurt", "quark",
      "cottage cheese", "cream cheese", "cheese", "mozzarella", "parmesan", "feta", "cheddar", "gouda", "halloumi",
      "ricotta", "mascarpone", "paneer", "egg", "tofu", "oat milk", "soy milk", "buttermilk", "fresh yeast",
      "puff pastry", "pizza dough", "gnocchi", "hummus"],
    "meat-fish": ["chicken breast", "chicken thigh", "chicken", "minced beef", "minced meat", "beef", "pork", "bacon",
      "ham", "sausage", "chorizo", "lamb", "salmon", "smoked salmon", "cod", "prawn"],
    "frozen": ["pea", "frozen spinach", "frozen berry", "edamame", "ice cream"],
    "household": ["baking paper", "aluminium foil", "cling film", "kitchen roll"]
  }') a, json_each(a.value) b;

INSERT INTO ingredient_aliases (alias, base)
  SELECT key, value FROM json_each('{
    "eggplant": "aubergine", "zucchini": "courgette", "capsicum": "bell pepper", "red pepper": "bell pepper",
    "green pepper": "bell pepper", "yellow pepper": "bell pepper", "sweet pepper": "bell pepper",
    "pepper": "black pepper", "peppercorn": "black pepper", "cilantro": "coriander", "coriander leaf": "coriander",
    "scallion": "spring onion", "green onion": "spring onion", "garbanzo bean": "chickpea", "chick pea": "chickpea",
    "cannellini bean": "white bean", "haricot bean": "white bean", "navy bean": "white bean",
    "heavy cream": "cream", "double cream": "cream", "whipping cream": "cream", "single cream": "cream",
    "yoghurt": "yogurt", "natural yogurt": "yogurt", "greek yoghurt": "greek yogurt", "schmand": "sour cream",
    "powdered sugar": "icing sugar", "confectioners sugar": "icing sugar", "caster sugar": "sugar",
    "granulated sugar": "sugar", "cornstarch": "cornflour", "corn starch": "cornflour", "all-purpose flour": "flour",
    "wheat flour": "flour", "bicarbonate of soda": "baking soda", "instant yeast": "dry yeast", "yeast": "dry yeast",
    "active dry yeast": "dry yeast", "ground beef": "minced beef", "beef mince": "minced beef", "mince": "minced meat",
    "mixed mince": "minced meat", "shrimp": "prawn", "king prawn": "prawn", "arugula": "rocket", "bok choy": "pak choi",
    "beet": "beetroot", "chilli": "chili", "chile": "chili", "chilli flake": "chili flake",
    "red pepper flake": "chili flake", "chilli powder": "chili powder", "kashmiri chilli powder": "kashmiri chili powder",
    "tomato puree": "tomato paste", "canned tomato": "chopped tomato", "tinned tomato": "chopped tomato",
    "diced tomato": "chopped tomato", "parmigiano reggiano": "parmesan", "parmesan cheese": "parmesan",
    "mozzarella cheese": "mozzarella", "feta cheese": "feta", "cheddar cheese": "cheddar", "sesame": "sesame seed",
    "vegetable broth": "vegetable stock", "stock cube": "vegetable stock", "stock": "vegetable stock",
    "chicken broth": "chicken stock", "neutral oil": "vegetable oil", "canola oil": "rapeseed oil",
    "lime juice": "lime", "lime zest": "lime", "lemon juice": "lemon", "lemon zest": "lemon",
    "garlic clove": "garlic", "egg yolk": "egg", "egg white": "egg", "soya sauce": "soy sauce",
    "long grain rice": "rice", "jasmine rice": "rice", "arborio rice": "risotto rice", "rolled oats": "oats",
    "porridge oats": "oats", "oat": "oats", "shredded coconut": "desiccated coconut", "chocolate": "dark chocolate",
    "vanilla essence": "vanilla extract", "vanilla bean": "vanilla pod", "mint leaf": "mint", "basil leaf": "basil",
    "plum tomato": "tomato", "vine tomato": "tomato", "waxy potato": "potato", "floury potato": "potato",
    "button mushroom": "mushroom", "chestnut mushroom": "mushroom", "romaine lettuce": "lettuce",
    "iceberg lettuce": "lettuce", "swiss chard": "chard", "chicken breast fillet": "chicken breast",
    "salmon fillet": "salmon", "cod fillet": "cod", "sweetcorn": "corn", "spaghetti noodle": "spaghetti",
    "makrut lime leaf": "kaffir lime leaf", "panko breadcrumb": "panko", "sea salt": "salt", "flaky salt": "salt",
    "frozen pea": "pea", "garden pea": "pea", "dried oregano": "oregano", "fresh coriander": "coriander"
  }');
