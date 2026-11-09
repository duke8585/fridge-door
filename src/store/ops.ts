import type { Comment, CoverFocus, RecipeDetail, RecipeSummary, ShoppingItem, Stars, User } from "../../shared/schema";
import { applyTagDelta, upgradeTag } from "../../shared/tags";

/**
 * Every mutation that may happen offline is one of these. Each maps to an
 * idempotent request, so replaying after a lost response is harmless.
 */
export type OutboxOp =
  | { kind: "shopping"; item: ShoppingItem }
  | { kind: "rating"; recipe_id: string; user: User; stars: Stars }
  | { kind: "tags.delta"; recipe_id: string; user: User; add: string[]; remove: string[]; at?: string }
  | { kind: "cover.focus"; recipe_id: string; user: User; focus: CoverFocus | null; at?: string }
  | { kind: "comment.put"; comment: Comment }
  | { kind: "comment.delete"; id: string; recipe_id: string; user: User };

export function opRecipeId(op: OutboxOp): string | undefined {
  switch (op.kind) {
    case "shopping":
      return undefined;
    case "comment.put":
      return op.comment.recipe_id;
    default:
      return op.recipe_id;
  }
}

const later = (a: string, b: string | undefined): string => (b !== undefined && b > a ? b : a);

/**
 * Apply a pending op to the recipe's row in the library list. Tags and the cover crop move
 * updated_at like the server does (`at`, the time of the edit; ops queued by older builds have
 * none), so "Recently modified" shows what was just done, also offline. Ratings are patched by the
 * caller, which knows every rating of the recipe.
 */
export function applyOpToSummary(s: RecipeSummary, op: OutboxOp): RecipeSummary {
  if (opRecipeId(op) !== s.id) return s;
  switch (op.kind) {
    case "tags.delta":
      return { ...s, tags: applyTagDelta(s.tags, { add: op.add.map(upgradeTag), remove: op.remove.map(upgradeTag) }), updated_at: later(s.updated_at, op.at) };
    case "cover.focus":
      return { ...s, cover_focus: op.focus, updated_at: later(s.updated_at, op.at) };
    default:
      return s;
  }
}

/**
 * Apply a pending op to a recipe snapshot. Used for optimistic UI and to
 * re-apply not-yet-synced ops on top of a fresh server copy.
 */
export function applyOp(d: RecipeDetail, op: OutboxOp): RecipeDetail {
  if (opRecipeId(op) !== d.recipe.id) return d;
  switch (op.kind) {
    case "rating": {
      const ratings = d.recipe.ratings.filter((r) => r.user !== op.user).concat({ user: op.user, stars: op.stars });
      ratings.sort((a, b) => a.user.localeCompare(b.user));
      return { ...d, recipe: { ...d.recipe, ratings } };
    }
    case "tags.delta":
      // An op queued by a build from before the tag groups carries old names; the server maps them the same way.
      return {
        ...d,
        recipe: { ...d.recipe, tags: applyTagDelta(d.recipe.tags, { add: op.add.map(upgradeTag), remove: op.remove.map(upgradeTag) }), updated_at: later(d.recipe.updated_at, op.at) },
      };
    case "cover.focus":
      return { ...d, recipe: { ...d.recipe, cover_focus: op.focus, updated_at: later(d.recipe.updated_at, op.at) } };
    case "comment.put": {
      const exists = d.comments.some((c) => c.id === op.comment.id);
      const comments = exists
        ? d.comments.map((c) => (c.id === op.comment.id ? op.comment : c))
        : [...d.comments, op.comment];
      return { ...d, comments };
    }
    case "comment.delete":
      return { ...d, comments: d.comments.filter((c) => c.id !== op.id) };
    case "shopping":
      return d;
    default:
      // Unknown kind (e.g. an op queued by an older build): leave the snapshot alone.
      return d;
  }
}
