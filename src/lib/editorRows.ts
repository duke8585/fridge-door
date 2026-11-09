/** Pure helpers for the editor's ingredient rows (strings while typing). Kept out of the component so they are testable. */
import { parseIngredientLine } from "../../shared/parse";
import type { Ingredient } from "../../shared/schema";

export type Row = { key: string; qty: string; qtyMax: string; unit: string; item: string; prep: string; note: string };
export type DraftSection = { key: string; title: string; rows: Row[] };
export const FIELDS = ["qty", "qtyMax", "unit", "item", "prep", "note"] as const;
export type Field = (typeof FIELDS)[number];

let keySeq = 0;
export const newKey = (): string => `k${++keySeq}`;
export const emptyRow = (): Row => ({ key: newKey(), qty: "", qtyMax: "", unit: "", item: "", prep: "", note: "" });
export const isEmptyRow = (r: Row): boolean => FIELDS.every((f) => r[f].trim() === "");

export function rowFromIngredient(i: Ingredient): Row {
  return {
    key: newKey(),
    qty: i.qty?.toString() ?? "",
    qtyMax: i.qtyMax?.toString() ?? "",
    unit: i.unit ?? "",
    item: i.item,
    prep: i.prep ?? "",
    note: i.note ?? "",
  };
}

/**
 * "200 g flour, sifted" typed as a whole line into Item (qty and unit still empty) -> split into
 * the row's fields. Returns undefined when there is nothing to split (plain "flour", or qty already set).
 * Prep/note typed separately are kept unless the line itself has one.
 */
export function smartSplitRow(r: Row): Row | undefined {
  if (r.qty.trim() || r.unit) return undefined;
  const parsed = parseIngredientLine(r.item);
  if (!parsed || (parsed.qty === undefined && !parsed.note && !parsed.prep)) return undefined;
  const next = rowFromIngredient(parsed);
  return { ...next, key: r.key, prep: next.prep || r.prep, note: next.note || r.note };
}

export type Pos = { si: number; ri: number };

/** Move a row up/down; at a section edge it hops into the neighbouring section. Returns the new position. */
export function moveRow(sections: readonly DraftSection[], at: Pos, dir: -1 | 1): { sections: DraftSection[]; at: Pos } | undefined {
  const next = sections.map((s) => ({ ...s, rows: [...s.rows] }));
  const sec = next[at.si];
  if (!sec) return undefined;
  const target = at.ri + dir;
  if (target >= 0 && target < sec.rows.length) {
    [sec.rows[at.ri], sec.rows[target]] = [sec.rows[target]!, sec.rows[at.ri]!];
    return { sections: next, at: { si: at.si, ri: target } };
  }
  const other = next[at.si + dir];
  if (!other) return undefined;
  const [row] = sec.rows.splice(at.ri, 1);
  if (dir === -1) other.rows.push(row!);
  else other.rows.unshift(row!);
  if (sec.rows.length === 0) sec.rows.push(emptyRow());
  return { sections: next, at: { si: at.si + dir, ri: dir === -1 ? other.rows.length - 1 : 0 } };
}

/**
 * Backspace in a fully empty row: delete it and return the row to focus (the previous one,
 * crossing into the previous section; else the next one). The last row of a section is kept
 * (a section always has a row) and focus just moves back.
 */
export function deleteEmptyRow(sections: readonly DraftSection[], at: Pos): { sections: DraftSection[]; focus?: string } | undefined {
  const sec = sections[at.si];
  const row = sec?.rows[at.ri];
  if (!sec || !row || !isEmptyRow(row)) return undefined;
  const flat = sections.flatMap((s) => s.rows.map((r) => r.key));
  const i = flat.indexOf(row.key);
  const focus = flat[i - 1] ?? flat[i + 1];
  if (sec.rows.length === 1) return focus === undefined ? undefined : { sections: [...sections], focus: flat[i - 1] ?? focus };
  const next = sections.map((s, si) => (si === at.si ? { ...s, rows: s.rows.filter((_, ri) => ri !== at.ri) } : s));
  return { sections: next, focus };
}
