/**
 * Single source of truth for data shapes, shared by the Worker (validation)
 * and the client (types + optional pre-validation). Keep this free of
 * runtime-specific imports so both tsconfigs can include it.
 */
import { z } from "zod";
import { METRIC_UNITS, USERS } from "./constants";
import { tagProblem, upgradeTag } from "./tags";

export { METRIC_UNITS, USERS };

export const MetricUnitSchema = z.enum(METRIC_UNITS);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const UserSchema = z.enum(USERS);
export type User = z.infer<typeof UserSchema>;

const qtySchema = z.number().positive("Must be > 0").max(100_000, "Too large");

export const IngredientSchema = z
  .object({
    item: z.string().trim().min(1, "Item is required").max(120),
    qty: qtySchema.optional(),
    qtyMax: qtySchema.optional(),
    unit: MetricUnitSchema.optional(),
    prep: z.string().trim().max(120).optional(),
    note: z.string().trim().max(120).optional(),
  })
  .superRefine((ing, ctx) => {
    if (ing.qtyMax !== undefined && ing.qty === undefined) {
      ctx.addIssue({ code: "custom", path: ["qty"], message: "Range needs a min qty" });
    }
    if (ing.qtyMax !== undefined && ing.qty !== undefined && ing.qtyMax <= ing.qty) {
      ctx.addIssue({ code: "custom", path: ["qtyMax"], message: "Max must be > qty" });
    }
    if (ing.unit !== undefined && ing.qty === undefined) {
      ctx.addIssue({ code: "custom", path: ["qty"], message: "Unit without qty - use a note instead" });
    }
  });
export type Ingredient = z.infer<typeof IngredientSchema>;

export const SectionSchema = z.object({
  title: z.string().trim().max(80).optional(),
  ingredients: z.array(IngredientSchema).max(100),
});
export type Section = z.infer<typeof SectionSchema>;

export const YieldSchema = z.object({
  amount: z.number().positive("Must be > 0").max(1000),
  unit: z.string().trim().min(1, "Unit is required").max(40),
});
export type Yield = z.infer<typeof YieldSchema>;

export const StarsSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export type Stars = z.infer<typeof StarsSchema>;

export const MAX_TAGS = 20;
/** "group:value" from the scheme in shared/tags.ts. */
export const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((t, ctx) => {
    const problem = tagProblem(t);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
export const TagsSchema = z.array(TagSchema).max(MAX_TAGS);
/**
 * Tag edits from the recipe view are deltas, so two people adding tags concurrently both win.
 * They may have been queued offline by a build from before the tag scheme, so legacy names are
 * mapped first (an old "vegan" adds diet:vegan). Removing any string is allowed: it only ever
 * takes a tag away.
 */
export const TagDeltaSchema = z.object({
  add: z.array(z.string().transform(upgradeTag).pipe(TagSchema)).max(MAX_TAGS).default([]),
  remove: z.array(z.string().max(100).transform(upgradeTag)).max(MAX_TAGS).default([]),
});

/** Minutes. Overnight soaking counts, hence up to a week. `active_min` is hands-on time. */
export const TimeSchema = z
  .object({
    total_min: z.number().int("Whole minutes").positive("Must be > 0").max(7 * 24 * 60, "Too long"),
    active_min: z.number().int("Whole minutes").positive("Must be > 0").optional(),
  })
  .refine((t) => t.active_min === undefined || t.active_min <= t.total_min, {
    path: ["active_min"],
    message: "Active time cannot exceed total",
  });
export type Time = z.infer<typeof TimeSchema>;

/** What the editor submits (create or full replace). */
export const RecipeInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(140),
  yield: YieldSchema.optional(),
  sections: z.array(SectionSchema).min(1, "At least one section").max(20),
  steps_md: z.string().max(20_000),
  notes_md: z.string().max(20_000),
  source_url: z.url("Must be a valid URL").optional(),
  tags: TagsSchema,
  time: TimeSchema.optional(),
});
export type RecipeInput = z.infer<typeof RecipeInputSchema>;

const percent = z.number().min(0, "0-100").max(100, "0-100");
/** Focal point of the cover in percent of the image, used as CSS object-position. null = DEFAULT_FOCUS. */
export const CoverFocusSchema = z.object({ x: percent, y: percent });
export type CoverFocus = z.infer<typeof CoverFocusSchema>;
export const CoverFocusPatchSchema = z.object({ cover_focus: CoverFocusSchema.nullable() });

export type Rating = { user: User; stars: Stars };
/** `cover_key` is the R2 key, served at `/api/<cover_key>`. `source_ref` is set on imported recipes ("asana:<gid>"). */
export type Recipe = RecipeInput & {
  id: string;
  ratings: Rating[];
  updated_at: string;
  cover_key?: string;
  cover_focus: CoverFocus | null;
  source_ref?: string;
};

/** `ingredients` (item names) and `notes_md` are there for the list's search. */
export type RecipeSummary = {
  id: string;
  title: string;
  tags: string[];
  ingredients: string[];
  notes_md: string;
  yield?: Yield;
  time?: Time;
  cover_key?: string;
  cover_focus: CoverFocus | null;
  avg_rating: number | null;
  rating_count: number;
  created_at: string;
  updated_at: string;
};

export const CommentInputSchema = z.object({
  recipe_id: z.string().min(1),
  body_md: z.string().trim().min(1, "Comment is empty").max(5000),
});
export type Comment = {
  id: string;
  recipe_id: string;
  user: User;
  body_md: string;
  created_at: string;
  updated_at: string;
};

export type RecipeDetail = { recipe: Recipe; comments: Comment[] };

/**
 * One recipe from a bulk import (import/asana_map.py merge), PUT to /api/import/:source_ref.
 * `source_ref` is "asana:<gid>", or "asana:<gid>:<n>" for part n of a task split into several recipes.
 * The recipe content, ratings and comments come from the source; `section` and `review` are
 * kept for the importer's report and not stored. `cover_focus` is a proposal: it never replaces a
 * focus the user set in the editor. null and absent hash the same, so adding it does not churn records.
 */
export const ImportRecordSchema = z.object({
  source_ref: z.string().regex(/^[a-z]+:[A-Za-z0-9_-]{1,64}(:[1-9][0-9]{0,2})?$/, "Expected <system>:<id> or <system>:<id>:<part>"),
  status: z.enum(["full", "stub"]),
  section: z.string().nullable(),
  cover: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(jpe?g|png|webp)$/i, "Expected <gid>/<file>.<jpg|png|webp>").nullable(),
  cover_focus: CoverFocusSchema.nullable().transform((f) => f ?? undefined).optional(),
  ratings: z.array(z.object({ user: UserSchema, stars: StarsSchema })).max(USERS.length),
  comments: z.array(z.object({ user: UserSchema, body_md: z.string().trim().min(1).max(5000), created_at: z.iso.datetime() })).max(200),
  recipe: RecipeInputSchema.extend({ time: TimeSchema }),
  review: z.array(z.string().min(1).max(300)),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;
export type ImportStatus = "created" | "updated" | "unchanged";
export type ImportResult = { id: string; status: ImportStatus; cover_key: string | null };

/**
 * Shopping item as it travels over the wire and lives in IndexedDB.
 * `deleted` is a tombstone so deletions propagate to the other device.
 */
export const ShoppingItemSchema = z.object({
  id: z.string().min(1).max(64),
  item: z.string().trim().min(1, "Item is required").max(120),
  qty: qtySchema.optional(),
  qtyMax: qtySchema.optional(),
  unit: MetricUnitSchema.optional(),
  recipe_id: z.string().max(64).optional(),
  recipe_title: z.string().max(140).optional(),
  checked: z.boolean(),
  deleted: z.boolean().optional(),
  updated_at: z.iso.datetime(),
});
export type ShoppingItem = z.infer<typeof ShoppingItemSchema>;

export const ShoppingSyncRequestSchema = z.object({
  items: z.array(ShoppingItemSchema).max(500),
  since: z.number().int().min(0),
});
export type ShoppingSyncRequest = z.infer<typeof ShoppingSyncRequestSchema>;
export type ShoppingSyncResponse = { items: ShoppingItem[]; rev: number };

export type FieldErrors = Record<string, string>;
export type ValidationErrorBody = { error: "validation"; fields: FieldErrors };

/** Flatten zod issues into "sections.0.ingredients.2.qty" -> message. */
export function toFieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
