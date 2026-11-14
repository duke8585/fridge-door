/**
 * A draft without the model: schema.org Recipe data mapped field by field. Used when AI import is
 * unavailable (no key, credits used up, key rejected). Only safe parses are kept; anything else
 * stays as the source wrote it, for the user to fix in the editor.
 */
import { parseIngredientLine } from "../shared/parse";
import { type Ingredient, IngredientSchema, type RecipeInput, type Yield } from "../shared/schema";
import { groupValues, makeTag } from "../shared/tags";
import { instructionSteps, type JsonObject, str, strs } from "./extract";
import type { Draft } from "./ingest";

export const NO_AI_NOTE = "imported without AI: check units and translation";
const IMPERIAL = /\b(cups?|oz|ounces?|lbs?|pounds?|fl\.? ?oz|quarts?|pints?|sticks?)\b|°\s?F/i;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function ldDraft(ld: JsonObject, sourceUrl: string, title: string): Draft {
  const review = [NO_AI_NOTE];
  const ingredients = strs(ld.recipeIngredient ?? ld.ingredients).map(ingredientFromLine);
  const steps = instructionSteps(ld.recipeInstructions);
  let section: string | undefined;
  const stepLines: string[] = [];
  steps.forEach((s, i) => {
    if (s.section && s.section !== section) stepLines.push(`**${s.section}**`, "");
    section = s.section;
    stepLines.push(`${i + 1}. ${s.text}`);
  });
  const yieldValue = parseYield(strs(ld.recipeYield));
  const total = isoMinutes(str(ld.totalTime)) ?? sum(isoMinutes(str(ld.prepTime)), isoMinutes(str(ld.cookTime)));
  const recipe: RecipeInput = {
    title,
    ...(yieldValue && { yield: yieldValue }),
    ...(total && { time: { total_min: total } }),
    sections: [{ ingredients }],
    steps_md: stepLines.join("\n"),
    notes_md: strs(ld.recipeNotes ?? ld.notes).join("\n\n"),
    source_url: sourceUrl,
    tags: vocabularyTags(ld),
  };
  if (!steps.length) review.push("no method in source");
  return { recipe, review_notes: review };
}

/** A parse the schema accepts and that has no imperial unit, else the line as written, in the note. */
function ingredientFromLine(line: string): Ingredient {
  const parsed = IMPERIAL.test(line) ? undefined : parseIngredientLine(line);
  if (parsed && (parsed.qty !== undefined || parsed.note) && IngredientSchema.safeParse(parsed).success) return parsed;
  return { item: cut(parsed?.item || line, 120), note: cut(line, 120) };
}

function parseYield(values: string[]): Yield | undefined {
  for (const v of values) {
    const m = v.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
    if (!m) continue;
    const amount = Number(m[1]!.replace(",", "."));
    if (amount > 0 && amount <= 1000) return { amount, unit: cut(m[2]!.trim() || "servings", 40) };
  }
  return undefined;
}

/** ISO 8601 durations as schema.org writes them (PT1H30M, P1DT2H). */
export function isoMinutes(v: string | undefined): number | undefined {
  const m = v?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i);
  if (!m) return undefined;
  const min = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return min > 0 && min <= 7 * 1440 ? min : undefined;
}

const sum = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0) || undefined;

const COURSE_ALIASES: Readonly<Record<string, string>> = {
  "main course": "main",
  "main dish": "main",
  dinner: "main",
  lunch: "main",
  "side dish": "side",
  appetizer: "snack",
  starter: "snack",
  beverage: "drink",
  bread: "baking",
  cake: "baking",
};

/** Category and cuisine words that are literally in the vocabulary (at most 2 course, 1 cuisine). */
function vocabularyTags(ld: JsonObject): string[] {
  const words = [...strs(ld.recipeCategory), ...strs(ld.keywords).flatMap((k) => k.split(","))].map((w) => w.trim().toLowerCase());
  const course = [...new Set(words.map((w) => COURSE_ALIASES[w] ?? w).filter((w) => groupValues("course").includes(w)))].slice(0, 2);
  const cuisine = strs(ld.recipeCuisine)
    .map((w) => w.trim().toLowerCase())
    .find((w) => groupValues("cuisine").includes(w));
  return [...course.map((v) => makeTag("course", v)), ...(cuisine ? [makeTag("cuisine", cuisine)] : [])];
}
