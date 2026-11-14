import { TIME_FILTERS } from "../../shared/time";
import { DEFAULT_SORT, SORTS, type Sort, type SortDir } from "./recipeSort";

export type ListFilter = { q: string; tags: ReadonlySet<string>; time: string | null; sort: Sort };

const KEYS = ["q", "tag", "time", "sort", "dir"];

/** Read ?q=, ?tag= (repeated), ?time= and ?sort=&dir= from a query string; unknown values fall back to the default. */
export function readFilter(search: string): ListFilter {
  const p = new URLSearchParams(search);
  const time = p.get("time");
  const sort = SORTS.find((s) => s.id === p.get("sort"));
  const dir = p.get("dir");
  return {
    q: p.get("q") ?? "",
    tags: new Set(p.getAll("tag")),
    time: TIME_FILTERS.some((f) => f.id === time) ? time : null,
    sort: sort ? { id: sort.id, dir: dir === "asc" || dir === "desc" ? (dir as SortDir) : sort.first } : DEFAULT_SORT,
  };
}

/** The query string for a filter; params equal to the default are left out. Other params are kept. */
export function writeFilter(search: string, f: ListFilter): string {
  const p = new URLSearchParams(search);
  for (const k of KEYS) p.delete(k);
  if (f.q) p.set("q", f.q);
  for (const t of f.tags) p.append("tag", t);
  if (f.time) p.set("time", f.time);
  if (f.sort.id !== DEFAULT_SORT.id || f.sort.dir !== DEFAULT_SORT.dir) {
    p.set("sort", f.sort.id);
    p.set("dir", f.sort.dir);
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}
