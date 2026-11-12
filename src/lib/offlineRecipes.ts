/**
 * Which recipes on the shopping list to fetch so they open offline in the shop: the ones this
 * device has not cached, and the ones the library list shows in a newer version than the cache.
 * `listed` is the library list (id -> updated_at), undefined until it has loaded. A recipe that is
 * not in a loaded list was deleted, so it is skipped instead of answering 404 on every sync.
 */
export function recipesToCache(
  onList: Iterable<string>,
  cached: ReadonlyMap<string, string>,
  listed: ReadonlyMap<string, string> | undefined,
): string[] {
  const out: string[] = [];
  for (const id of new Set(onList)) {
    const have = cached.get(id);
    const latest = listed?.get(id);
    if (listed && latest === undefined) continue;
    if (have === undefined || (latest !== undefined && latest > have)) out.push(id);
  }
  return out;
}
