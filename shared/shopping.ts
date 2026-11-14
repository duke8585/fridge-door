import { type Aisle, type Catalogue, completeAisleOrder, EMPTY_CATALOGUE, resolveLocal } from "./catalogue";
import type { Ingredient, ShoppingItem } from "./schema";

/**
 * Last-write-wins merge of remote rows into the local map, per item, on updated_at.
 * Ties go to the remote copy because the server already resolved them the same way,
 * so both sides converge on what D1 holds. Returns ids that changed locally.
 */
export function mergeRemote(local: Map<string, ShoppingItem>, remote: readonly ShoppingItem[]): string[] {
  const changed: string[] = [];
  for (const r of remote) {
    const l = local.get(r.id);
    if (!l || r.updated_at >= l.updated_at) {
      if (!l || !sameItem(l, r)) changed.push(r.id);
      local.set(r.id, r);
    }
  }
  return changed;
}

function sameItem(a: ShoppingItem, b: ShoppingItem): boolean {
  return (
    a.updated_at === b.updated_at &&
    a.checked === b.checked &&
    !!a.deleted === !!b.deleted &&
    a.item === b.item &&
    a.qty === b.qty &&
    a.qtyMax === b.qtyMax &&
    a.unit === b.unit &&
    a.base === b.base &&
    a.aisle === b.aisle
  );
}

/**
 * Monotonic per-item timestamp: never older than the previous write, so rapid
 * check/uncheck on one device always moves forward even if the clock jitters.
 * ISO strings in UTC with ms compare correctly as strings.
 */
export function nextTimestamp(prev?: string, now: Date = new Date()): string {
  const t = now.getTime();
  const p = prev ? Date.parse(prev) : 0;
  return new Date(Math.max(t, p + 1)).toISOString();
}

export type ShoppingGroup = {
  /** The base: "red apple" and "apples" are one group, "apple". */
  key: string;
  aisle: Aisle;
  lines: ShoppingItem[];
  allChecked: boolean;
};

/**
 * The base and aisle a row is grouped under. Rows carry them since the catalogue exists; older rows
 * and rows typed in offline that the local catalogue did not know are looked up in `cat` meanwhile.
 */
export function placeOf(it: ShoppingItem, cat: Catalogue = EMPTY_CATALOGUE): { base: string; aisle: Aisle } {
  const local = it.base && it.aisle ? null : resolveLocal(cat, it.item);
  const base = it.base ?? local!.base;
  return { base, aisle: it.aisle ?? cat.aisles.get(base) ?? local?.aisle ?? "other" };
}

/**
 * Group live (non-deleted) items by base, alphabetical; a ticked group keeps its place. A group's aisle
 * is that of its most recently written line, so a move shows at once even before every line synced.
 */
export function groupShopping(items: Iterable<ShoppingItem>, cat: Catalogue = EMPTY_CATALOGUE): ShoppingGroup[] {
  const groups = new Map<string, ShoppingGroup & { at: string }>();
  for (const it of items) {
    if (it.deleted) continue;
    const { base, aisle } = placeOf(it, cat);
    let g = groups.get(base);
    if (!g) {
      g = { key: base, aisle, lines: [], allChecked: true, at: it.updated_at };
      groups.set(base, g);
    }
    if (it.updated_at > g.at) {
      g.at = it.updated_at;
      g.aisle = aisle;
    }
    g.lines.push(it);
    if (!it.checked) g.allChecked = false;
  }
  const out = [...groups.values()].map(({ at: _, ...g }) => g);
  for (const g of out) g.lines.sort((a, b) => (a.recipe_title ?? "").localeCompare(b.recipe_title ?? ""));
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export type AisleSection = { aisle: Aisle; groups: ShoppingGroup[] };

/** The groups under their aisles, in the household order (`order` is completed, so every aisle has a place). Empty aisles are left out. */
export function byAisle(groups: readonly ShoppingGroup[], order: readonly string[] | undefined): AisleSection[] {
  return completeAisleOrder(order)
    .map((aisle) => ({ aisle, groups: groups.filter((g) => g.aisle === aisle) }))
    .filter((s) => s.groups.length > 0);
}

/**
 * Build shopping rows from (already scaled) ingredients. Unscalable items come along without qty.
 * Each row carries the ingredient's base and, when the catalogue knows the base, its aisle.
 */
export function ingredientsToShopping(
  ingredients: readonly Ingredient[],
  recipe: { id: string; title: string },
  makeId: () => string,
  now: string,
  cat: Catalogue = EMPTY_CATALOGUE,
): ShoppingItem[] {
  return ingredients.map((ing) => ({
    id: makeId(),
    item: ing.item,
    base: ing.base,
    aisle: ing.base ? cat.aisles.get(ing.base) : undefined,
    qty: ing.qty,
    qtyMax: ing.qtyMax,
    unit: ing.unit,
    recipe_id: recipe.id,
    recipe_title: recipe.title,
    checked: false,
    updated_at: now,
  }));
}
