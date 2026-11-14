/**
 * The one path for recipes that enter from outside the editor (MCP create_recipe, import from a
 * link): the style-guide lint, the duplicate guard, the server-derived board tags, and the review
 * notes posted as an "Import notes:" comment. Callers parse their input with DraftSchema first.
 */
import { z } from "zod";
import { type DuplicateCandidate, findDuplicates } from "../shared/duplicates";
import { lintRecipe, withBoardTags } from "../shared/lint";
import { type Comment, MAX_TAGS, type RecipeInput, RecipeInputSchema, type User } from "../shared/schema";
import type { AiEnv } from "./ai";
import { resolveRecipe } from "./catalogue";
import * as repo from "./repo";

export const MAX_REVIEW_NOTES = 15;
export const ReviewNotesSchema = z.array(z.string().trim().min(1).max(300)).max(MAX_REVIEW_NOTES);

/** A recipe plus the review flags of whoever wrote it (a model or the import), before saving. */
export const DraftSchema = z.object({ recipe: RecipeInputSchema, review_notes: ReviewNotesSchema });
export type Draft = z.infer<typeof DraftSchema>;

/**
 * Every reason the draft breaks the contract: the style-guide lint plus the tag limit after the
 * server tags are added. `allowedTags` (tags the recipe already has) may come from groups the
 * writer cannot set itself, such as list:* or status:stub.
 */
export function draftProblems(draft: Draft, allowedTags: Iterable<string> = []): string[] {
  const asLint = { recipe: draft.recipe, review: draft.review_notes };
  const problems = lintRecipe(asLint, new Set(allowedTags));
  const tags = withBoardTags(asLint);
  if (tags.length > MAX_TAGS) problems.push(`${tags.length} tags, at most ${MAX_TAGS} (board tags included)`);
  return problems;
}

/** The recipe as stored: content tags plus the tags the server derives (status:stub, todo:method). */
export const withServerTags = (draft: Draft): RecipeInput => ({ ...draft.recipe, tags: withBoardTags({ recipe: draft.recipe, review: draft.review_notes }) });

export function notesComment(recipeId: string, user: User, heading: string, notes: readonly string[], now: string): Comment | null {
  if (!notes.length) return null;
  return {
    id: `c-${crypto.randomUUID()}`,
    recipe_id: recipeId,
    user,
    body_md: `${heading}\n${notes.map((n) => `- ${n}`).join("\n")}`,
    created_at: now,
    updated_at: now,
  };
}

export type IngestSource = "mcp" | "url-import";
export type IngestResult =
  | { ok: true; id: string }
  | { ok: false; reason: "problems"; problems: string[] }
  | { ok: false; reason: "duplicate"; candidates: DuplicateCandidate[] };

/** Lint, then the duplicate guard (skipped with confirmDuplicate), then create with resolved bases and the notes comment. */
export async function ingestRecipe(
  env: AiEnv,
  draft: Draft,
  opts: { author: User; source: IngestSource; confirmDuplicate: boolean; now: string },
): Promise<IngestResult> {
  const db = env.DB;
  const problems = draftProblems(draft);
  if (problems.length) return { ok: false, reason: "problems", problems };
  if (!opts.confirmDuplicate) {
    const candidates = findDuplicates(draft.recipe, await repo.recipeIndex(db));
    if (candidates.length) return { ok: false, reason: "duplicate", candidates };
  }
  const id = await repo.freshRecipeId(db, draft.recipe.title);
  await repo.upsertRecipe(db, id, await resolveRecipe(env, withServerTags(draft)), { author: opts.author, source: opts.source, now: opts.now });
  const comment = notesComment(id, opts.author, "Import notes:", draft.review_notes, opts.now);
  if (comment) await repo.putComment(db, comment);
  return { ok: true, id };
}
