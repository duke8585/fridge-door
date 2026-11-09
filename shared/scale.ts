import type { Ingredient, MetricUnit } from "./schema";

export const SPOON_ML: Partial<Record<MetricUnit, number>> = { tsp: 5, tbsp: 15 };

/** Round to the nearest multiple of `step`, avoiding float noise. */
function roundTo(value: number, step: number): number {
  return Math.round(Math.round(value / step) * step * 1000) / 1000;
}

/** Step size for a mass/volume amount in g or ml. */
function gramStep(v: number): number {
  if (v < 5) return 0.5;
  if (v < 20) return 1;
  if (v < 100) return 5;
  if (v < 500) return 10;
  return 25;
}

/** Promote/demote between g<->kg and ml<->l (exact, no rounding) so "1250 g" reads "1.25 kg". */
function promote(qty: number, unit?: MetricUnit): { qty: number; unit?: MetricUnit } {
  if ((unit === "g" || unit === "ml") && qty >= 1000) return { qty: qty / 1000, unit: unit === "g" ? "kg" : "l" };
  if ((unit === "kg" || unit === "l") && qty < 1) return { qty: qty * 1000, unit: unit === "kg" ? "g" : "ml" };
  return { qty, unit };
}

/** Round in the given unit, never changing it. */
function roundInUnit(qty: number, unit?: MetricUnit): number {
  switch (unit) {
    case "piece":
    case "clove":
      return Math.max(0.5, roundTo(qty, 0.5));
    case "tsp":
      return Math.max(0.25, roundTo(qty, 0.25));
    case "tbsp":
      return Math.max(0.5, roundTo(qty, 0.5));
    case "g":
    case "ml":
      return Math.max(gramStep(qty), roundTo(qty, gramStep(qty)));
    case "kg":
    case "l":
      return roundTo(qty, qty < 2 ? 0.05 : 0.1);
    default:
      // unit-less counts behave like pieces
      return Math.max(0.5, roundTo(qty, qty < 10 ? 0.5 : 1));
  }
}

/**
 * Round a scaled quantity sensibly for its unit and promote/demote between
 * g<->kg and ml<->l so "1250 g" reads "1.25 kg" and "0.3 l" reads "300 ml".
 */
export function roundQty(qty: number, unit?: MetricUnit): { qty: number; unit?: MetricUnit } {
  const p = promote(qty, unit);
  const rounded = roundInUnit(p.qty, p.unit);
  // Rounding can cross the threshold (990 g -> 1000 g), so promote once more.
  const again = promote(rounded, p.unit);
  return again.unit === p.unit ? { qty: rounded, unit: p.unit } : { qty: roundInUnit(again.qty, again.unit), unit: again.unit };
}

/**
 * Scale one ingredient. Ingredients without qty never scale. At x1 amounts are kept exact
 * (no rounding) but the unit is still promoted, so "1250 g" shows "1.25 kg" at every factor.
 */
export function scaleIngredient(ing: Ingredient, factor: number): Ingredient {
  if (ing.qty === undefined) return ing;
  const exact = factor === 1;
  const lo = exact ? promote(ing.qty, ing.unit) : roundQty(ing.qty * factor, ing.unit);
  const loQty = exact ? roundTo(lo.qty, 0.001) : lo.qty;
  const base = { ...ing, qty: loQty, unit: lo.unit };
  delete base.qtyMax;
  if (ing.qtyMax === undefined) return base;
  // Scale the max in the same unit the min ended up in so "800-1200 g" stays one unit.
  const hiRaw = ing.qtyMax * factor * (unitMultiplier(ing.unit) / unitMultiplier(lo.unit));
  const hi = exact ? roundTo(hiRaw, 0.001) : roundInUnit(hiRaw, lo.unit);
  return hi > loQty ? { ...base, qtyMax: hi } : base;
}

function unitMultiplier(unit?: MetricUnit): number {
  return unit === "kg" || unit === "l" ? 1000 : 1;
}

export function factorForYield(baseAmount: number | undefined, target: number): number {
  if (!baseAmount || baseAmount <= 0 || target <= 0) return 1;
  return target / baseAmount;
}

const FRACTIONS: Record<string, string> = { "0.25": "¼", "0.5": "½", "0.75": "¾" };

/** "1.5" -> "1½" for spoons and counts, plain decimals otherwise. */
export function formatNumber(n: number, unit?: MetricUnit): string {
  const useFractions = unit === undefined || unit === "tsp" || unit === "tbsp" || unit === "piece" || unit === "clove";
  if (useFractions) {
    const whole = Math.floor(n);
    const frac = FRACTIONS[String(roundTo(n - whole, 0.25))];
    if (frac) return whole === 0 ? frac : `${whole}${frac}`;
  }
  // kg/l keep gram precision so an unscaled "1234 g" -> "1.234 kg" loses nothing.
  return String(roundTo(n, unit === "kg" || unit === "l" ? 0.001 : 0.01));
}

const UNIT_LABEL: Record<MetricUnit, [string, string]> = {
  g: ["g", "g"],
  kg: ["kg", "kg"],
  ml: ["ml", "ml"],
  l: ["l", "l"],
  tsp: ["tsp", "tsp"],
  tbsp: ["tbsp", "tbsp"],
  piece: ["", ""],
  clove: ["clove", "cloves"],
};

export function formatQty(qty: number | undefined, qtyMax: number | undefined, unit?: MetricUnit): string {
  if (qty === undefined) return "";
  const range = qtyMax !== undefined ? `${formatNumber(qty, unit)}-${formatNumber(qtyMax, unit)}` : formatNumber(qty, unit);
  if (!unit) return range;
  const [one, many] = UNIT_LABEL[unit];
  const label = (qtyMax ?? qty) > 1 ? many : one;
  return label ? `${range} ${label}` : range;
}

/** "15 ml" / "15-30 ml" for spoon units, undefined for anything else. */
export function spoonInMl(qty: number | undefined, qtyMax: number | undefined, unit?: MetricUnit): string | undefined {
  const ml = unit ? SPOON_ML[unit] : undefined;
  if (!ml || qty === undefined) return undefined;
  const lo = roundTo(qty * ml, 0.5);
  return qtyMax !== undefined ? `${lo}-${roundTo(qtyMax * ml, 0.5)} ml` : `${lo} ml`;
}
