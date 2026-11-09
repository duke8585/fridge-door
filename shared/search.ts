/** Recipe search, shared by the list page (client side, offline) and the MCP search_recipes tool. */
import { tagValue } from "./tags";

export type Searchable = { title: string; tags: readonly string[]; ingredients: readonly string[]; notes_md: string };

/** Lowercased fields per recipe object, so typing does not rebuild them on every keystroke. */
type Fields = [title: string, tagsAndIngredients: string, notes: string];
const cache = new WeakMap<Searchable, Fields>();

function fields(r: Searchable): Fields {
  let f = cache.get(r);
  if (!f) {
    f = [r.title.toLowerCase(), [...r.tags.map(tagValue), ...r.ingredients].join("\n").toLowerCase(), r.notes_md.toLowerCase()];
    cache.set(r, f);
  }
  return f;
}

export const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * How well a recipe matches: every query word must appear (case-insensitive, as a substring) in
 * the title, the tag values, the ingredient items or the notes. 0 = all words in the title,
 * 1 = in title, tags and ingredients, 2 = only with the notes too, null = no match.
 */
export function searchRank(r: Searchable, words: readonly string[]): number | null {
  if (words.length === 0) return 0;
  const [title, mid, notes] = fields(r);
  let haystack = title;
  for (const [rank, extra] of [[0, ""], [1, mid], [2, notes]] as const) {
    if (extra) haystack += `\n${extra}`;
    if (words.every((w) => haystack.includes(w))) return rank;
  }
  return null;
}

/** The matching recipes, title matches first; within a rank the input order is kept. */
export function searchRecipes<T extends Searchable>(list: readonly T[], query: string): T[] {
  const words = queryWords(query);
  if (words.length === 0) return [...list];
  return list
    .map((r) => ({ r, rank: searchRank(r, words) }))
    .filter((x): x is { r: T; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.r);
}
