/**
 * A recipe as plain text for messengers and notes apps, which do not render markdown: a title
 * line, "-" bullets and the steps as written, with emphasis marks and link syntax taken out.
 * No photo, tags, ratings or comments. `link` (the recipe in the app) ends it as an HTML comment.
 */

import { ingredientLine, scaleSections } from "../../shared/recipeMarkdown";
import { formatNumber } from "../../shared/scale";
import type { Recipe } from "../../shared/schema";
import { formatTime } from "../../shared/time";

/** Markdown to readable text: links become "text (url)", headings and emphasis lose their marks. */
export function plainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text: string, url: string) => (text === url ? url : `${text} (${url})`))
    .replace(/^#{1,6}\s+(.*)$/gm, "$1:")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[*+]\s+/gm, "- ")
    .trim();
}

export function recipeToText(recipe: Recipe, factor = 1, link?: string): string {
  const out: string[] = [recipe.title];
  const facts: string[] = [];
  if (recipe.yield) facts.push(`${formatNumber(recipe.yield.amount * factor)} ${recipe.yield.unit}`);
  if (recipe.time) facts.push(formatTime(recipe.time));
  if (facts.length) out.push(facts.join(" · "));
  out.push("", "Ingredients");
  for (const s of scaleSections(recipe.sections, factor)) {
    if (s.title) out.push("", `${s.title}:`);
    out.push(...s.ingredients.map((i) => `- ${ingredientLine(i)}`));
  }
  if (recipe.steps_md.trim()) out.push("", "Steps", plainText(recipe.steps_md));
  if (recipe.notes_md.trim()) out.push("", "Notes", plainText(recipe.notes_md));
  if (recipe.source_url) out.push("", `Source: ${recipe.source_url}`);
  if (link) out.push("", `<!-- from Fridge Door: ${link} -->`);
  return out.join("\n");
}

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

/**
 * The share sheet where there is one (phones), else the clipboard. Only `text` goes to the sheet:
 * a separate title is put in front of the text by many apps, and the text already starts with it.
 */
export async function shareText(text: string): Promise<ShareResult> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // a share sheet that refuses (e.g. NotAllowedError) falls through to the clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
