/** The library's sort orders and direction, and the per-device choice. */
import type { RecipeSummary } from "../../shared/schema";

/** `desc` is the first click's direction: newest, best rated, A first. */
export const SORTS = [
  { id: "modified", label: "Modified", first: "desc" },
  { id: "added", label: "Created", first: "desc" },
  { id: "rating", label: "Rating", first: "desc" },
  { id: "az", label: "A-Z", first: "asc" },
] as const;
export type SortId = (typeof SORTS)[number]["id"];
export type SortDir = "asc" | "desc";
export type Sort = { id: SortId; dir: SortDir };
export const DEFAULT_SORT: Sort = { id: "modified", dir: "desc" };

type Sortable = Pick<RecipeSummary, "title" | "avg_rating" | "created_at" | "updated_at">;

const byTitle = (a: Sortable, b: Sortable): number => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
/** ISO timestamps compare as strings; oldest first. */
const byTime = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Clicking the active sort flips it; another sort starts in its own first direction. */
export function nextSort(cur: Sort, id: SortId): Sort {
  if (cur.id === id) return { id, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { id, dir: SORTS.find((s) => s.id === id)!.first };
}

/**
 * Ascending order of each key; desc reverses it. Unrated recipes stay last in both directions,
 * and every order ends on the title (always A first) so ties stay in a fixed order.
 */
export function compareRecipes({ id, dir }: Sort): (a: Sortable, b: Sortable) => number {
  const s = dir === "asc" ? 1 : -1;
  switch (id) {
    case "modified":
      return (a, b) => s * byTime(a.updated_at, b.updated_at) || byTitle(a, b);
    case "added":
      return (a, b) => s * byTime(a.created_at, b.created_at) || byTitle(a, b);
    case "rating":
      return (a, b) =>
        (a.avg_rating === null ? 1 : 0) - (b.avg_rating === null ? 1 : 0) || s * ((a.avg_rating ?? 0) - (b.avg_rating ?? 0)) || byTitle(a, b);
    case "az":
      return (a, b) => s * byTitle(a, b);
  }
}

const KEY = "fd_sort";
const parse = (v: string | null): Sort => {
  const [id, dir] = (v ?? "").split(":");
  const known = SORTS.find((s) => s.id === id);
  if (!known) return DEFAULT_SORT;
  return { id: known.id, dir: dir === "asc" || dir === "desc" ? dir : known.first };
};

/** localStorage can be missing or throw (private mode, blocked storage): fall back to the default. */
export function loadSort(): Sort {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveSort(sort: Sort): void {
  try {
    localStorage.setItem(KEY, `${sort.id}:${sort.dir}`);
  } catch {
    /* not remembered on this device */
  }
}
