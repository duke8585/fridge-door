import type { Ingredient, MetricUnit, Section } from "./schema";

const UNIT_ALIASES: Record<string, MetricUnit> = {
  g: "g", gr: "g", gram: "g", grams: "g", gramm: "g",
  kg: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  ml: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml",
  l: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp", tl: "tsp",
  tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", el: "tbsp",
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", x: "piece",
  clove: "clove", cloves: "clove",
};

const UNICODE_FRACTIONS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };

const NOTE_PHRASES = ["to taste", "a pinch", "pinch of", "a handful", "handful of", "a dash", "dash of", "as needed", "optional", "a few", "some"];

/** Parse "1", "1.5", "1,5", "1/2", "1 1/2", "1½", "½". Returns undefined if not a number. */
export function parseNumber(raw: string): number | undefined {
  const s = raw.trim().replace(",", ".");
  if (!s) return undefined;
  const uni = s.match(/^(\d+)?\s*([¼½¾⅓⅔⅛])$/);
  if (uni) return Number(uni[1] ?? 0) + (UNICODE_FRACTIONS[uni[2]!] ?? 0);
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[2]) === 0 ? undefined : Number(frac[1]) / Number(frac[2]);
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return undefined;
}

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*\s*[¼½¾⅓⅔⅛]|\d+(?:[.,]\d+)?)`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|to)\s*(${NUM}))?\s*(.*)$`, "i");

/**
 * Parse one free-text ingredient line into a structured Ingredient.
 * Examples:
 *   "200 g flour, sifted"            -> {qty:200, unit:"g", item:"flour", prep:"sifted"}
 *   "2-3 cloves garlic, minced"      -> {qty:2, qtyMax:3, unit:"clove", item:"garlic", prep:"minced"}
 *   "salt (to taste)" / "salt to taste" -> {item:"salt", note:"to taste"}
 *   "3 eggs"                         -> {qty:3, unit:"piece", item:"eggs"}
 * Returns undefined for blank lines.
 */
export function parseIngredientLine(line: string): Ingredient | undefined {
  let rest = line.trim().replace(/^[-*•]\s+/, "");
  if (!rest) return undefined;

  const out: Ingredient = { item: "" };

  // Trailing "(note)".
  const paren = rest.match(/\(([^)]*)\)\s*$/);
  if (paren) {
    out.note = paren[1]!.trim() || undefined;
    rest = rest.slice(0, paren.index).trim();
  }

  const q = rest.match(QTY_RE);
  if (q) {
    const lo = parseNumber(q[1]!);
    const hi = q[2] ? parseNumber(q[2]) : undefined;
    if (lo !== undefined) {
      out.qty = lo;
      if (hi !== undefined && hi > lo) out.qtyMax = hi;
      rest = q[3]!.trim();
      const unitMatch = rest.match(/^([a-zA-Z]+)\.?(?:\s+|$)(.*)$/);
      const unit = unitMatch ? UNIT_ALIASES[unitMatch[1]!.toLowerCase()] : undefined;
      if (unit && unitMatch) {
        out.unit = unit;
        rest = unitMatch[2]!.trim();
      } else {
        out.unit = "piece";
      }
      rest = rest.replace(/^of\s+/i, "");
    }
  }

  // Leading/trailing note phrases like "a pinch of salt" or "salt to taste".
  if (out.qty === undefined && !out.note) {
    const lower = rest.toLowerCase();
    for (const phrase of NOTE_PHRASES) {
      if (lower.startsWith(phrase + " ")) {
        out.note = phrase.replace(/ of$/, "").replace(/^(pinch|handful|dash)$/, "a $1");
        rest = rest.slice(phrase.length).trim().replace(/^of\s+/i, "");
        break;
      }
      if (lower.endsWith(" " + phrase) || lower.endsWith(", " + phrase)) {
        out.note = phrase;
        rest = rest.slice(0, rest.length - phrase.length).trim().replace(/,$/, "").trim();
        break;
      }
    }
  }

  const comma = rest.indexOf(",");
  if (comma >= 0) {
    const prep = rest.slice(comma + 1).trim();
    rest = rest.slice(0, comma).trim();
    if (prep) out.prep = prep;
  }

  out.item = rest;
  if (!out.item) return undefined;
  return out;
}

/**
 * Parse a pasted block. Lines ending with ":" ("For the sauce:") start a new section.
 * The first section has no title unless the block starts with a header.
 */
export function parseIngredientBlock(text: string): Section[] {
  const sections: Section[] = [{ ingredients: [] }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith(":") && !/^\d/.test(line)) {
      const title = line.slice(0, -1).trim();
      const last = sections[sections.length - 1]!;
      if (last.ingredients.length === 0 && last.title === undefined) last.title = title;
      else sections.push({ title, ingredients: [] });
      continue;
    }
    const ing = parseIngredientLine(line);
    if (ing) sections[sections.length - 1]!.ingredients.push(ing);
  }
  return sections.filter((s) => s.ingredients.length > 0 || s.title);
}
