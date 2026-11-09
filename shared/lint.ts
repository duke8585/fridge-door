/**
 * The style rules of import/NORMALIZE.md that the schema cannot express. One implementation for
 * scripts/check-import.ts (LLM normalizer output) and the MCP create/update tools.
 */
import type { RecipeInput } from "./schema";
import { groupCountProblems, NEEDS_METHOD_TAG, parseTag, STUB_TAG, TAG_GROUPS, tagProblem } from "./tags";

/** A recipe plus the normalizer's review flags. "stub" and "no source" in `review` carry meaning. */
export type RecipeDraft = { recipe: RecipeInput; review: readonly string[] };

const IMPERIAL = /\b(cups?|oz|ounces?|lbs?|pounds?|fl\.? ?oz|°\s?F|fahrenheit|quarts?|pints?|sticks? of butter)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
export const TRACKING_PARAM = /^(si|igsh|utm_[a-z]+|fbclid|gclid|pp)$/;

export const isStub = (d: RecipeDraft): boolean => d.review.includes("stub") || d.recipe.tags.includes(STUB_TAG);

/**
 * Every problem with the draft, empty when it follows the contract. Tags must be valid (shared/tags.ts),
 * from a group the content writer may set, and within each group's limits. `allowedTags` may be
 * set on top (tags the recipe already had, e.g. a list or status tag kept by update_recipe).
 */
export function lintRecipe(d: RecipeDraft, allowedTags: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const { recipe, review } = d;
  const stub = isStub(d);
  const tags = recipe.tags;
  for (const t of tags) {
    const problem = tagProblem(t);
    const group = parseTag(t)?.group;
    if (problem || !group) out.push(`tag ${problem}`);
    else if (!TAG_GROUPS[group].content && !allowedTags.has(t)) out.push(`tag "${t}": ${group} tags are set by the server or the owners, not by the recipe writer`);
  }
  out.push(...groupCountProblems(tags));
  if (EMOJI.test(recipe.title)) out.push("emoji in title");
  if (recipe.title === recipe.title.toUpperCase() && /[A-Z]{4}/.test(recipe.title)) out.push("title in caps");
  const ings = recipe.sections.flatMap((s) => s.ingredients);
  for (const i of ings) if (i.qty === undefined && !i.note) out.push(`no qty and no note: ${i.item}`);
  const text = [recipe.steps_md, recipe.notes_md, ...ings.flatMap((i) => [i.item, i.prep ?? "", i.note ?? ""])].join("\n");
  if (IMPERIAL.test(text)) out.push(`imperial unit in text: "${text.match(IMPERIAL)?.[0]}"`);
  if (recipe.source_url && hasTrackingParam(recipe.source_url)) out.push("tracking parameter in source_url");
  if (stub && !recipe.source_url && !review.includes("no source")) out.push('stub without source_url needs review "no source"');
  if (/promo|link in bio|highlight/i.test(recipe.notes_md)) out.push("promo text in notes");
  if (!stub) {
    if (ings.length === 0) out.push("no ingredients but not flagged stub");
    if (recipe.steps_md.trim() && !/^1\. /m.test(recipe.steps_md)) out.push("steps_md is not a numbered list");
  }
  return out;
}

function hasTrackingParam(url: string): boolean {
  try {
    return [...new URL(url).searchParams.keys()].some((k) => TRACKING_PARAM.test(k));
  } catch {
    return false;
  }
}

/**
 * The tags the server derives, as import/asana_map.py merge does: status:stub for a stub, and
 * todo:method exactly when a non-stub has no steps (so writing the method removes it).
 */
export function withBoardTags(d: RecipeDraft): string[] {
  const stub = isStub(d);
  const needsMethod = !stub && !d.recipe.steps_md.trim();
  const tags = d.recipe.tags.filter((t) => t !== NEEDS_METHOD_TAG);
  return [...new Set([...tags, ...(stub ? [STUB_TAG] : []), ...(needsMethod ? [NEEDS_METHOD_TAG] : [])])];
}
