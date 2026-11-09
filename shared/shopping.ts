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
    a.unit === b.unit
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

export const groupKey = (item: string): string => item.trim().toLowerCase().replace(/\s+/g, " ");

export type ShoppingGroup = {
  key: string;
  label: string;
  lines: ShoppingItem[];
  allChecked: boolean;
};

/** Group live (non-deleted) items by normalized name. Unchecked groups first, then alphabetical. */
export function groupShopping(items: Iterable<ShoppingItem>): ShoppingGroup[] {
  const groups = new Map<string, ShoppingGroup>();
  for (const it of items) {
    if (it.deleted) continue;
    const key = groupKey(it.item);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: it.item.trim(), lines: [], allChecked: true };
      groups.set(key, g);
    }
    g.lines.push(it);
    if (!it.checked) g.allChecked = false;
  }
  const out = [...groups.values()];
  for (const g of out) g.lines.sort((a, b) => (a.recipe_title ?? "").localeCompare(b.recipe_title ?? ""));
  return out.sort((a, b) => Number(a.allChecked) - Number(b.allChecked) || a.key.localeCompare(b.key));
}

/** Build shopping rows from (already scaled) ingredients. Unscalable items come along without qty. */
export function ingredientsToShopping(
  ingredients: readonly Ingredient[],
  recipe: { id: string; title: string },
  makeId: () => string,
  now: string,
): ShoppingItem[] {
  return ingredients.map((ing) => ({
    id: makeId(),
    item: ing.item,
    qty: ing.qty,
    qtyMax: ing.qtyMax,
    unit: ing.unit,
    recipe_id: recipe.id,
    recipe_title: recipe.title,
    checked: false,
    updated_at: now,
  }));
}
