/** Recipe search, shared by the list page (client side, offline) and the MCP search_recipes tool. */
import { EMPTY_CATALOGUE, resolveLocal, type Catalogue } from "./catalogue";
import { tagValue } from "./tags";

/** `bases`: the ingredients' catalogue bases, so "apples" finds "red apple". Missing in summaries cached by older builds. */
export type Searchable = { title: string; tags: readonly string[]; ingredients: readonly string[]; bases?: readonly string[]; notes_md: string };

/** Lowercased fields per recipe object, so typing does not rebuild them on every keystroke. */
type Fields = [title: string, tagsAndIngredients: string, notes: string, bases: ReadonlySet<string>];
const cache = new WeakMap<Searchable, Fields>();

function fields(r: Searchable): Fields {
  let f = cache.get(r);
  if (!f) {
    f = [r.title.toLowerCase(), [...r.tags.map(tagValue), ...r.ingredients].join("\n").toLowerCase(), r.notes_md.toLowerCase(), new Set(r.bases)];
    cache.set(r, f);
  }
  return f;
}

/** A query word and the base it resolves to through the catalogue (or the rules alone). */
export type QueryTerm = { word: string; base: string };

export const queryTerms = (query: string, cat: Catalogue = EMPTY_CATALOGUE): QueryTerm[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ word, base: resolveLocal(cat, word).base }));

/**
 * How well a recipe matches: every query word must appear (case-insensitive, as a substring) in
 * the title, the tag values, the ingredient items or the notes, or resolve to one of the recipe's
 * ingredient bases. 0 = all words in the title, 1 = in title, tags and ingredients, 2 = only with
 * the notes too, null = no match.
 */
export function searchRank(r: Searchable, terms: readonly QueryTerm[]): number | null {
  if (terms.length === 0) return 0;
  const [title, mid, notes, bases] = fields(r);
  let haystack = title;
  for (const [rank, extra] of [[0, ""], [1, mid], [2, notes]] as const) {
    if (extra) haystack += `\n${extra}`;
    if (terms.every((t) => haystack.includes(t.word) || (rank > 0 && bases.has(t.base)))) return rank;
  }
  return null;
}

/** The matching recipes, title matches first; within a rank the input order is kept. */
export function searchRecipes<T extends Searchable>(list: readonly T[], query: string, cat?: Catalogue): T[] {
  const terms = queryTerms(query, cat);
  if (terms.length === 0) return [...list];
  return list
    .map((r) => ({ r, rank: searchRank(r, terms) }))
    .filter((x): x is { r: T; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.r);
}
