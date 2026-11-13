/**
 * The ingredient catalogue scheme, defined once: aisles, the deterministic resolution rules, and
 * the guide for writing `item`. The Worker (D1 catalogue, Haiku fallback), the client (offline
 * shopping list and search), NORMALIZE.md, the MCP guide and the link-import prompt all read it.
 * No zod here, so the client bundle can import it.
 */

/** In the default household order: a generic German supermarket, cold and frozen goods last. */
export const AISLES = [
  { id: "produce", label: "Fruit and vegetables" },
  { id: "bakery", label: "Bread and bakery" },
  { id: "grains", label: "Pasta, rice and grains" },
  { id: "baking", label: "Baking, nuts and dried fruit" },
  { id: "spices", label: "Spices and stock" },
  { id: "oils-sauces", label: "Oils, vinegar and sauces" },
  { id: "canned", label: "Cans and jars" },
  { id: "international", label: "World foods" },
  { id: "sweets-snacks", label: "Sweets and snacks" },
  { id: "drinks", label: "Drinks" },
  { id: "dairy", label: "Dairy, eggs and chilled" },
  { id: "meat-fish", label: "Meat and fish" },
  { id: "frozen", label: "Frozen" },
  { id: "household", label: "Household" },
  { id: "other", label: "Other" },
  { id: "home", label: "Likely at home" },
] as const;

export type Aisle = (typeof AISLES)[number]["id"];
export const AISLE_IDS = AISLES.map((a) => a.id) as [Aisle, ...Aisle[]];
export const DEFAULT_AISLE_ORDER: readonly Aisle[] = AISLE_IDS;
const AISLE_SET: ReadonlySet<string> = new Set(AISLE_IDS);
export const isAisle = (s: string): s is Aisle => AISLE_SET.has(s);
export const aisleLabel = (a: Aisle): string => AISLES.find((x) => x.id === a)!.label;

/** Where a catalogue entry came from: the starter migration, the model, or a person. */
export type Origin = "seed" | "auto" | "user";

/** A stored order made complete: unknown and repeated ids dropped, missing aisles appended in default order. */
export function completeAisleOrder(order: readonly string[] | undefined): Aisle[] {
  const out = [...new Set((order ?? []).filter(isAisle))];
  for (const a of DEFAULT_AISLE_ORDER) if (!out.includes(a)) out.push(a);
  return out;
}

/** The household's aisle order, last-write-wins on updated_at like shopping items. */
export type AisleOrder = { order: Aisle[]; updated_at: string };

/** Lowercase, accents dropped, whitespace collapsed: how aliases and bases are keyed. */
export const itemKey = (item: string): string =>
  item
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Words that stay as they are although they end in "s". */
const INVARIANT = new Set(["oats", "couscous", "hummus", "asparagus", "molasses", "grits", "swiss", "brussels", "citrus", "series", "bus", "lemongrass"]);
const IRREGULAR: Readonly<Record<string, string>> = { leaves: "leaf", halves: "half", loaves: "loaf", cookies: "cookie", pies: "pie", knives: "knife" };

export function singularize(word: string): string {
  if (INVARIANT.has(word) || word.length < 4) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(oes|ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is)$/.test(word)) return word;
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/** The key with its last word singular: "Red Apples" -> "red apple". Every base and alias is stored in this form. */
export function singularKey(item: string): string {
  const words = itemKey(item).split(" ");
  words.push(singularize(words.pop()!));
  return words.join(" ");
}

/**
 * Words that describe an ingredient without changing what to buy: temperature, colour, freshness,
 * size, prep and quality. Kinds that do change it ("brown sugar", "black bean", "ground coriander",
 * "hot sauce", "red onion", "white wine") are catalogue entries, and the lookup tries the longer
 * name before dropping a word. Not here, because they change the product: dried, canned, frozen,
 * smoked, roasted, pickled, cooked, sweet, mixed, instant.
 */
const DESCRIPTORS = new Set(
  ("ripe large small medium chopped diced sliced grated peeled halved quartered shredded cubed julienned finely roughly thinly coarsely drained rinsed trimmed " +
    "cold hot warm lukewarm boiling chilled fresh freshly organic plain toasted unsalted salted natural very overripe extra virgin granulated powdered liquid ground " +
    "red green yellow white black whole unsweetened mild light baby mini curly slivered crushed shelled cooked filtered ice-cold").split(" "),
);

/** Diet qualifiers that do not change the ingredient: "low fat cottage cheese", "sugar free jelly". */
const DIET_QUALIFIER = /\b(?:(?:low|reduced|full|zero|no)[ -](?:fat|carb|sugar|salt|sodium)|(?:fat|sugar|gluten|lactose)[ -]free)\b/g;
/** "cold or sparkling water", "chicken or vegetable stock": one word, "or", a longer name; read as first word + its last word. */
const SHARED_NOUN = /^(\p{L}+) or [^,;]+ (\p{L}+)\s*(?:[,;].*)?$/u;

/** Notes, punctuation and diet qualifiers dropped: "low fat cottage cheese" -> "cottage cheese". */
const clean = (name: string): string =>
  name
    .replace(DIET_QUALIFIER, " ")
    .replace(/[^\p{L}\p{N}' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The core names of `item`, singular: the shared-noun reading of an alternative first when there is
 * one ("cold or sparkling water" -> "cold water"), then the first alternative ("cold"). The lookup
 * keeps whichever the catalogue knows, so "salt or black pepper" still lands on "salt".
 */
function coreNames(item: string): string[] {
  const key = itemKey(item).replace(/\([^)]*\)/g, " ").trim();
  const shared = SHARED_NOUN.exec(key);
  const cores = [shared ? `${shared[1]} ${shared[2]}` : "", key.split(/,|;| or /)[0]!].map((n) => singularKey(clean(n)));
  return [...new Set(cores.filter(Boolean))];
}

/** A core name, then leading descriptors dropped one by one, then every descriptor dropped. Empty when only descriptors are left. */
function descriptorChain(core: string): string[] {
  const words = core.split(" ");
  const stripped = words.filter((w) => !DESCRIPTORS.has(w)).join(" ");
  if (!stripped) return [];
  const out = [core];
  while (words.length > 1 && DESCRIPTORS.has(words[0]!)) {
    words.shift();
    out.push(words.join(" "));
  }
  out.push(stripped);
  return out;
}

/**
 * The names to look up for `item`, most specific first: the exact key, then each core name's
 * descriptor chain. The last one is the rule result used when nothing matches.
 */
export function candidateNames(item: string): string[] {
  return [...new Set([itemKey(item), ...coreNames(item).flatMap(descriptorChain)].filter(Boolean))];
}

/** The deterministic base for an item that is not in the catalogue. */
export const ruleBase = (item: string): string => candidateNames(item).at(-1) ?? itemKey(item);

/** A name in the form bases and aliases are stored in: the core name, keyed, last word singular. */
export const storedName = (name: string): string => coreNames(name)[0] ?? itemKey(name);

export type CatalogueEntry = { base: string; aisle: Aisle; origin: Origin };
export type CatalogueAlias = { alias: string; base: string; origin: Origin };
/** The whole catalogue as the API sends it. `version` changes whenever an entry does. */
export type CatalogueData = { version: string; bases: CatalogueEntry[]; aliases: CatalogueAlias[] };

/** Lookup form: every alias and every base (a base is its own alias) to its base, and each base's aisle. */
export type Catalogue = { readonly names: ReadonlyMap<string, string>; readonly aisles: ReadonlyMap<string, Aisle> };

export function buildCatalogue(data: Pick<CatalogueData, "bases" | "aliases">): Catalogue {
  const names = new Map<string, string>();
  const aisles = new Map<string, Aisle>();
  for (const b of data.bases) {
    names.set(b.base, b.base);
    aisles.set(b.base, b.aisle);
  }
  for (const a of data.aliases) if (!names.has(a.alias)) names.set(a.alias, a.base);
  return { names, aisles };
}

export const EMPTY_CATALOGUE: Catalogue = { names: new Map(), aisles: new Map() };

export type Resolution = { base: string; aisle: Aisle; how: "alias" | "rule" } | { base: string; aisle: "other"; how: "unknown" };

/** Steps 1 and 2 of the resolution: an exact alias, then the rule candidates. An unlisted "frozen X" keeps its name in the frozen aisle; anything else unknown keeps the rule result. */
export function resolveLocal(cat: Catalogue, item: string): Resolution {
  const [exact, ...rest] = candidateNames(item);
  const aisleOf = (base: string): Aisle => cat.aisles.get(base) ?? "other";
  const hit = exact === undefined ? undefined : cat.names.get(exact);
  if (hit) return { base: hit, aisle: aisleOf(hit), how: "alias" };
  for (const name of rest) {
    const base = cat.names.get(name);
    if (base) return { base, aisle: aisleOf(base), how: "rule" };
  }
  const base = ruleBase(item);
  if (base.startsWith("frozen ")) return { base, aisle: "frozen", how: "rule" };
  return { base, aisle: "other", how: "unknown" };
}

/**
 * How to write `item` so it resolves to the right base. NORMALIZE.md carries these lines between
 * generated markers (test/worker/normalize.test.ts keeps them equal), and through it the MCP
 * style guide and the link-import prompt.
 */
export const ITEM_RULES: readonly string[] = [
  '- `item` names one ingredient as a shop sells it: English, lowercase (proper nouns keep their capitals), singular where natural: "egg", "red onion", "chickpea", "coconut milk", "Dijon mustard".',
  '- Keep words that change what to buy ("brown sugar", "smoked paprika", "red lentil", "ground coriander"). Put preparation, size, ripeness and freshness into `prep` or `note`: item "onion" with prep "finely chopped", not "finely chopped onion".',
  '- One ingredient per line: "salt" and "black pepper" are two lines. Alternatives go into `note` ("or 1 tsp dried"), never "butter or margarine" in `item`.',
  "- No brands, amounts or packaging in `item`; use the common name (\"chickpea\", not \"canned Kichererbsen 400 g\").",
  "- The server maps every `item` to a canonical base (e.g. \"Granny Smith apples\" -> apple) and an aisle for the shopping list. A plain common name resolves without guessing.",
];
