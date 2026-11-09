import { parseNumber } from "../../shared/parse";

export const MAX_FACTOR = 50;
const MAX_SERVINGS = 999;

/** Parse a custom scale factor: "2", "0,75", "3/4", "1 1/2", "½", "x1.5". Undefined unless 0 < n <= MAX_FACTOR. */
export function parseFactor(raw: string): number | undefined {
  const n = parseNumber(raw.trim().replace(/^x\s*/i, ""));
  return n !== undefined && Number.isFinite(n) && n > 0 && n <= MAX_FACTOR ? n : undefined;
}

export type ScaleState = { servings: number; factor: number };

/** Read ?servings= (recipes with a yield) or ?factor= (recipes without) from a query string. */
export function readScale(search: string, yieldAmount: number | undefined): ScaleState {
  const p = new URLSearchParams(search);
  if (yieldAmount !== undefined) {
    const s = parseNumber(p.get("servings") ?? "");
    return { servings: s !== undefined && s >= 1 && s <= MAX_SERVINGS ? s : yieldAmount, factor: 1 };
  }
  return { servings: 1, factor: parseFactor(p.get("factor") ?? "") ?? 1 };
}

/** The query string for a scale state; params equal to the default are left out. Other params are kept. */
export function writeScale(search: string, state: ScaleState, yieldAmount: number | undefined): string {
  const p = new URLSearchParams(search);
  p.delete("servings");
  p.delete("factor");
  if (yieldAmount !== undefined) {
    if (state.servings !== yieldAmount) p.set("servings", String(state.servings));
  } else if (state.factor !== 1) {
    p.set("factor", String(state.factor));
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}
