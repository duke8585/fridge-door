# Recipe normalization contract

One contract for every way a recipe enters the app: the Asana backfill now, the URL importer
(Claude in the Worker) and MCP writes later. The checker is
`scripts/check-import.ts` (`npm run check-import`). A record that fails the checker is not done.

## Who decides what

| Field                                                                                                      | Decided by                                          |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `source_ref`, `status`, `cover`, `ratings`, `comments`, the `list:`, `status:` and `todo:` tags            | `import/asana_map.py`, deterministic, never the LLM |
| `recipe.*` content, the `course:`, `cuisine:`, `method:`, `diet:` and `collection:` tags, `time`, `review` | the normalizer (LLM), following this file           |

The normalizer writes `import/llm/<gid>.json` with only `{ recipe, review }`.
`asana_map.py` merges it with the deterministic fields into `import/out/<gid>.json`.

## Output shape (`import/llm/<gid>.json`)

```jsonc
{
  "recipe": {
    "title": "Cinnamon roll sheet cake",
    "yield": { "amount": 1, "unit": "tray (23 x 33 cm)" },   // omit when the source gives none
    "time": { "total_min": 55, "active_min": 20 },            // total required, active optional
    "sections": [ { "title": "Dough", "ingredients": [ ... ] } ],
    "steps_md": "1. ...\n2. ...",
    "notes_md": "...",
    "source_url": "https://...",                               // omit when none
    "tags": ["course:baking", "course:dessert", "method:oven", "cuisine:german"]
  },
  "review": ["cups converted to grams by density: red lentils"]  // empty when nothing is uncertain
}
```

## Language and tone

- English everywhere. Translate German sources fully.
- Titles: plain English, sentence case, no emojis, no ALL CAPS, no "(Vegan)" or source suffixes.
  Keep established dish names untranslated: dal makhani, socca, nam khao, khichdi.
- Steps: a numbered markdown list. Imperative, one or two actions per step, under ~40 words.
  Put temperatures (°C, fan or conventional said explicitly when the source says it), times,
  and appliance settings (air fryer 180 °C 18 min, Instant Pot high pressure 1 min, natural release)
  inside the step that uses them.
- Notes: tips, variations, serving suggestions, storage. Credit a person when the source does
  ("Via a colleague of Nakul."). No marketing text, no hashtags, no "link in bio".
- Do not invent. If the source has no steps, leave `steps_md` empty and say so in `review`.

## Ingredients

Shape: `{ item, qty?, qtyMax?, unit?, prep?, note? }`. Units: `g kg ml l tsp tbsp piece clove` only.
The server adds `base` from `item`; leave it out.

<!-- generated from ITEM_RULES in shared/catalogue.ts; test/worker/normalize.test.ts fails when this list differs -->
- `item` names one ingredient as a shop sells it: English, lowercase (proper nouns keep their capitals), singular where natural: "egg", "red onion", "chickpea", "coconut milk", "Dijon mustard".
- Keep words that change what to buy ("brown sugar", "smoked paprika", "red lentil", "ground coriander"). Put preparation, size, ripeness and freshness into `prep` or `note`: item "onion" with prep "finely chopped", not "finely chopped onion".
- One ingredient per line: "salt" and "black pepper" are two lines. Alternatives go into `note` ("or 1 tsp dried"), never "butter or margarine" in `item`.
- No brands, amounts or packaging in `item`; use the common name ("chickpea", not "canned Kichererbsen 400 g").
- The server maps every `item` to a canonical base (e.g. "Granny Smith apples" -> apple) and an aisle for the shopping list. A plain common name resolves without guessing.
<!-- end generated -->
- `prep` is what you do to it: "finely chopped", "washed twice", "soft".
- `note` is everything that is not a quantity: "to taste", "a pinch", "optional", "or 1 tsp dried",
  "medium". An ingredient without a `qty` must have a `note` saying why ("to taste", "for frying").
- Ranges: `qty: 1, qtyMax: 2`.
- Counted things use `piece` (eggs, onions, lemons) or `clove` (garlic).
- Convert everything to metric at write time:
  - US cups and ounces by ingredient density. Add each density-based conversion to `review`.
  - Water and other liquids: 1 cup = 240 ml, 1 fl oz = 30 ml.
  - German packets: Vanillezucker 1 Pck. = 8 g, Backpulver 1 Pck. = 15 g, Trockenhefe 1 Pck. = 7 g.
  - Cans: use the drained or net weight in g when known, otherwise `piece` with note "400 g can".
  - °F to °C, rounded to 5.
- `tsp` and `tbsp` stay as spoons. Never convert spoons to g.
- Group into sections when the source does (dough, filling, dressing, tadka). One untitled section
  otherwise.

## Time

`time.total_min` is required: from the source when given, otherwise your estimate, and then
`review` gets "time estimated". Soaking or resting overnight counts: say it in notes and include it
in total. `active_min` only when the source makes it clear.

## Tags

Every tag is `group:value`: a group from the list below, a colon, and a lowercase value with words
joined by "-" (`course:main`, `collection:cottage-cheese-ideas`). No tag without a group. Fixed
groups take only the values listed; free groups take any value. Set only the groups you may set,
within the counts in brackets.

<!-- generated from TAG_GROUPS in shared/tags.ts; test/worker/normalize.test.ts fails when this list differs -->
- `course` (1-2): breakfast, main, side, salad, soup, snack, dessert, baking, drink, sauce, basics. What kind of dish it is.
- `cuisine` (0-1): indian, italian, korean, thai, japanese, laotian, cambodian, middle-eastern, mexican, german, other. Only when the dish clearly belongs to one.
- `diet` (0-n): vegan, vegetarian. Only when the whole recipe as written is.
- `method` (0-3): oven, airfryer, instant-pot, one-pot, no-cook, batch. How it is cooked.
- `list` (never set by you): free value. A plan or set of the owners, e.g. list:next-up, list:birthday.
- `collection` (0-n): free value. Recipes split out of one source share one, e.g. collection:cottage-cheese-ideas.
- `status` (never set by you): stub. Set by the server: status:stub when the recipe is not written up.
- `todo` (never set by you): method, correction. Work left: todo:method (set by the server when there are no steps), todo:correction.
<!-- end generated -->

`diet:` only when the whole recipe as written is vegan or vegetarian (no "use vegan butter" swaps).
`collection:` only for recipes split out of one source (see "Several recipes in one source").

## Stubs

A stub is a task whose source is not readable as text: only an Instagram, YouTube or paywalled
link, a collection of ideas too vague to split (see "Several recipes in one source"), or empty
notes. For a stub:

- `title` cleaned up as usual, `source_url` set, any text from the notes kept verbatim (translated)
  in `notes_md`.
- `sections: [{ "ingredients": [] }]`, `steps_md: ""`, tags as far as you can tell.
- Ingredient words in the notes ("red lentils onion garlic carrot") become ingredients without qty,
  with note "amount not given".
- `review` gets "stub".

## Several recipes in one source

When one task holds several distinct recipes (a list of ideas, a set of drinks), write one file per
recipe, `import/llm/<gid>-<n>.json` with n = 1, 2, ... in source order, instead of `<gid>.json`.
Each part is a full record by the rules above: its own sentence-case title, its own ingredients,
steps only when the source has them for that part (otherwise empty, review "no method in source"),
its own notes and time, its own course and other tags, plus one shared
`collection:<the source title in kebab case>`, e.g. `collection:morning-matcha`. Keep the source's
`source_url` on every part. `asana_map.py merge` writes `out/<gid>-<n>.json` with `source_ref`
`asana:<gid>:<n>`, the task's ratings and comments on every part, and the cover on part 1 only.
Add the original gid to `import/skip.txt` once its parts exist.

## Edge cases (from the pilot)

- **Ratio-only sources** ("1 cup lentils : 3 cups water"): write quantities for the ratio's base
  unit (1 cup), state the ratio in notes, add "quantities scaled from ratio" to `review`.
- **Divided ingredients**: one line with the total and note "divided: 100 g + 100 g".
- **Proper nouns** stay capitalized in items: Kashmiri chili powder, Dijon mustard, Sichuan pepper.
- **Sections** only for groups the source titles. Blank-line groups without a title stay one section.
- **No method in the source** (common for Instagram captions that list only ingredients): leave
  `steps_md` empty and add `review` "no method in source". Never infer steps, from images or
  otherwise; the owners type the method in for the recipes they cook. Never describe cover images
  in notes. `asana_map.py` tags these `todo:method`.
- **Time**: use the source's total only when it covers the whole recipe and is plausible for the
  method. Otherwise estimate, and write `review` "time estimated: <breakdown>, source says <x>"
  (e.g. "time estimated: 20 prep + 40 bake + 90 cool + 10 frost, source says 40 min bake").
- **Promo text** ("link in bio", "find it in my highlight"): drop it and add "dropped promo text" to
  `review`.
- **Stubs**: text that became ingredients is not repeated in notes. A stub without any `source_url`
  gets `review` "no source".
- **Tracking parameters** (`si`, `igsh`, `utm_*`, `fbclid`, `pp`) are stripped from `source_url`.

## Review flags

Add a short line to `review` for anything a human should check: density conversions, estimated
time, guessed yield, unclear or contradictory source, a step you had to infer from a photo, a
possible duplicate of another task (name it). Never silently drop source content: if something does
not fit any field, put it in `notes_md`.
