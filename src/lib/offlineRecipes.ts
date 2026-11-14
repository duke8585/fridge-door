import type { RecipeSummary, User } from "../../shared/schema";

/**
 * Which recipes on the shopping list to fetch so they open offline in the shop: the ones this
 * device has not cached, and the ones the library list shows in a newer version than the cache.
 * `listed` is the library list (id -> updated_at), undefined until it has loaded. A recipe that is
 * not in a loaded list was deleted, so it is skipped instead of answering 404 on every sync.
 */
export function recipesToCache(onList: Iterable<string>, cached: ReadonlyMap<string, string>, listed: ReadonlyMap<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const id of new Set(onList)) {
    const have = cached.get(id);
    const latest = listed?.get(id);
    if (listed && latest === undefined) continue;
    if (have === undefined || (latest !== undefined && latest > have)) out.push(id);
  }
  return out;
}

/**
 * The recipes that should open offline: the ones on the shopping list and the ones I bookmarked.
 * `list` is the library list, undefined until it has loaded (then only the shopping list counts).
 */
export function recipesToKeep(onList: Iterable<string>, list: readonly Pick<RecipeSummary, "id" | "bookmarks">[] | undefined, me: User): string[] {
  const mine = (list ?? []).filter((r) => r.bookmarks.some((b) => b.user === me)).map((r) => r.id);
  return [...new Set([...onList, ...mine])];
}
