/** A recipe as one markdown document, the way a person would read it (used by the MCP get_recipe tool). */
import { formatNumber, formatQty, scaleIngredient } from "./scale";
import type { Ingredient, Recipe, Section } from "./schema";
import { formatTime } from "./time";

export const scaleSections = (sections: readonly Section[], factor: number): Section[] =>
  sections.map((s) => ({ ...s, ingredients: s.ingredients.map((i) => scaleIngredient(i, factor)) }));

export function ingredientLine(i: Ingredient): string {
  const qty = formatQty(i.qty, i.qtyMax, i.unit);
  const main = [qty, i.item].filter(Boolean).join(" ");
  return [main, i.prep, i.note].filter(Boolean).join(", ");
}

export function recipeToMarkdown(recipe: Recipe, factor = 1): string {
  const lines: string[] = [`# ${recipe.title}`, ""];
  const facts: string[] = [];
  if (recipe.yield) facts.push(`Yield: ${formatNumber(recipe.yield.amount * factor)} ${recipe.yield.unit}`);
  if (recipe.time) facts.push(`Time: ${formatTime(recipe.time)}`);
  if (factor !== 1) facts.push(`Scaled x${formatNumber(factor)}`);
  if (recipe.tags.length) facts.push(`Tags: ${recipe.tags.join(", ")}`);
  if (recipe.source_url) facts.push(`Source: ${recipe.source_url}`);
  if (facts.length) lines.push(...facts.map((f) => `- ${f}`), "");
  lines.push("## Ingredients", "");
  for (const s of scaleSections(recipe.sections, factor)) {
    if (s.title) lines.push(`### ${s.title}`, "");
    lines.push(...s.ingredients.map((i) => `- ${ingredientLine(i)}`), "");
  }
  lines.push("## Steps", "", recipe.steps_md.trim() || "(not written up yet)", "");
  if (recipe.notes_md.trim()) lines.push("## Notes", "", recipe.notes_md.trim(), "");
  return lines.join("\n");
}
