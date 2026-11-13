/**
 * The MCP tools. One McpServer per request (stateless), bound to the user the OAuth grant names,
 * so every write is attributed to that user and content writes record revision source "mcp".
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import styleGuide from "../import/NORMALIZE.md?raw";
import { AISLE_IDS, AISLES, buildCatalogue, resolveLocal, storedName } from "../shared/catalogue";
import { MAX_COVER_BYTES } from "../shared/cover";
import { recipeToMarkdown, scaleSections } from "../shared/recipeMarkdown";
import {
  CoverFocusSchema,
  MAX_TAGS,
  RecipeInputSchema,
  StarsSchema,
  TagSchema,
  type Comment,
  type Bookmark,
  type Rating,
  type User,
} from "../shared/schema";
import { ingredientsToShopping } from "../shared/shopping";
import { searchRank, queryTerms } from "../shared/search";
import { applyTagDelta, overMax, renameLegacyTag, STUB_TAG, TAG_GROUPS, TAG_GROUP_NAMES, tagProblem } from "../shared/tags";
import { backfillBases, placeShopping, resolveRecipe } from "./catalogue";
import { storeCover } from "./covers";
import { ReviewNotesSchema, draftProblems, ingestRecipe, notesComment, withServerTags } from "./ingest";
import { readAtMost } from "./pageFetch";
import * as repo from "./repo";

export type McpEnv = { DB: D1Database; COVERS: R2Bucket; ANTHROPIC_API_KEY?: string };
/** `origin` is the app's public origin, for links back to the recipes. */
export type McpContext = { env: McpEnv; user: User; origin: string };

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const fail = (message: string, data?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: data ? `${message}\n${JSON.stringify(data)}` : message }],
  isError: true,
});
const notFound = (id: string): ToolResult => fail(`No recipe with id "${id}". Use search_recipes to find ids.`);

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const now = (): string => new Date().toISOString();
const MAX_REDIRECTS = 3;
const MCP_COVER_TYPES: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const IdSchema = z.string().min(1).max(80).describe("Recipe id, from search_recipes");
const ScaleSchema = z.number().positive().max(50).optional().describe("Factor, e.g. 2 for double. Default 1");
const McpReviewNotesSchema = ReviewNotesSchema.optional().describe('Review flags per the style guide (e.g. "time estimated", "stub"). Posted as one comment');

const ratingsByUser = (ratings: readonly Rating[]): Partial<Record<User, number>> => Object.fromEntries(ratings.map((r) => [r.user, r.stars]));

const bookmarkedBy = (bookmarks: readonly Bookmark[]): User[] => bookmarks.map((b) => b.user);

function serverInstructions(user: User): string {
  return [
    `Fridge Door is the household recipe box of max and partner. You act as ${user}; every change is attributed to ${user}.`,
    "Call get_style_guide once before your first create_recipe or update_recipe and follow it exactly: English, metric units, a numbered steps list, tags only from the vocabulary.",
    "create_recipe and update_recipe reject recipes that break the guide and list every problem; fix all of them and retry.",
    "create_recipe also stops on a likely duplicate and shows the candidates. Retry with confirm_duplicate: true only when it is really a different recipe.",
    "update_recipe replaces the whole recipe: start from get_recipe and pass its updated_at as expected_updated_at.",
    "Every ingredient item is mapped to a canonical base and an aisle on save. Write items as the style guide says; lookup_ingredients shows what an item resolves to, set_ingredient corrects the catalogue when the user asks.",
    "set_bookmark saves or unsaves a recipe for you; search_recipes with bookmarked: true lists only yours, and get_recipe and search_recipes show bookmarked_by.",
    "There is no delete.",
  ].join("\n");
}

const MCP_PREAMBLE = `# Using this guide through MCP

The contract below was written for the Asana import. Through MCP:
- \`create_recipe.recipe\` is the guide's \`recipe\` object, and \`review_notes\` is its \`review\` list.
  The notes are posted as one comment by you that starts with "Import notes:".
- \`source_ref\`, \`status\`, \`cover\`, \`ratings\` and \`comments\` of the Asana record do not apply.
  Use set_cover_from_url, rate and add_comment instead.
- Every tag is group:value (see "Tags" below). In create_recipe and update_recipe you set only the
  groups the guide lets you set (course, cuisine, method, diet, collection). The server adds
  status:stub when review_notes has "stub", and todo:method to a non-stub without steps (removed
  once steps exist). update_recipe keeps the list:, status: and todo: tags the recipe has.
- When the user asks for it, set_tags adds any valid tag as them, e.g. list:next-up or
  todo:correction. Free groups (list, collection, from) take new values; reuse a value from
  "Tags in use now" where one fits.
- The server sets each ingredient's \`base\` from its \`item\` (leave \`base\` out). Before writing
  an unusual item, lookup_ingredients shows the base and aisle it would get.

`;

/** The prose guide plus the tags currently in use, so the model sees the live vocabulary. */
async function styleGuideText(db: D1Database): Promise<string> {
  const counts = await tagCounts(db);
  const live = counts.map(({ tag, count }) => `${tag} (${count})`).join(", ");
  return `${MCP_PREAMBLE}${styleGuide.trim()}\n\n## Tags in use now\n\n${live || "(none)"}\n`;
}

async function tagCounts(db: D1Database): Promise<{ tag: string; count: number }[]> {
  const counts = new Map<string, number>();
  for (const r of await repo.recipeIndex(db)) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** list_tags' view of shared/tags.ts: per group its fixed values (null = free), limits and who sets it. */
const VOCABULARY = Object.fromEntries(
  TAG_GROUP_NAMES.map((g) => {
    const s: { values?: readonly string[]; min?: number; max?: number; content: boolean; about: string } = TAG_GROUPS[g];
    return [g, { values: s.values ?? null, min: s.min ?? 0, max: s.max ?? null, set_by: s.content ? "recipe writer" : "server or owners", about: s.about }];
  }),
);

function lintFailure(tool: string, problems: readonly string[]): ToolResult {
  return fail(
    `Not saved: ${problems.length} problem${problems.length === 1 ? "" : "s"}. Fix all of them and call ${tool} again (rules: get_style_guide).\n${problems.map((p) => `- ${p}`).join("\n")}`,
  );
}

type FetchedImage = { ok: true; bytes: ArrayBuffer; type: string; ext: string } | { ok: false; message: string };

/** https only, at most 3 redirects (each https), jpeg/png/webp, at most 10 MB (checked while reading). */
export async function fetchCoverImage(imageUrl: string): Promise<FetchedImage> {
  let url = imageUrl;
  for (let hop = 0; ; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: `Not a valid URL: ${url}` };
    }
    if (parsed.protocol !== "https:") return { ok: false, message: `Only https image URLs are allowed (got ${parsed.protocol}//${parsed.host}).` };
    const res = await fetch(parsed.href, { redirect: "manual", headers: { accept: Object.keys(MCP_COVER_TYPES).join(", "), "user-agent": "FridgeDoor/1.0 (cover import)" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) return { ok: false, message: `More than ${MAX_REDIRECTS} redirects.` };
      url = new URL(location, parsed).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, message: `The image URL answered HTTP ${res.status}.` };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = MCP_COVER_TYPES[type];
    if (!ext) {
      await res.body?.cancel();
      return { ok: false, message: `Expected image/jpeg, image/png or image/webp, got "${type || "no content-type"}". Use the direct image URL, not the page.` };
    }
    const tooLarge = { ok: false, message: "The image is larger than 10 MB." } as const;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_COVER_BYTES) {
      await res.body?.cancel();
      return tooLarge;
    }
    const bytes = await readAtMost(res, MAX_COVER_BYTES);
    if (!bytes) return tooLarge;
    if (bytes.byteLength === 0) return { ok: false, message: "The image is empty." };
    return { ok: true, bytes, type, ext };
  }
}

export function createFridgeServer({ env, user, origin }: McpContext): McpServer {
  const db = env.DB;
  const change = (): repo.ContentChange => ({ author: user, source: "mcp", now: now() });
  const link = (id: string): string => `${origin}/recipes/${encodeURIComponent(id)}`;
  const server = new McpServer({ name: "fridge-door", version: "1.0.0" }, { instructions: serverInstructions(user) });

  server.registerTool(
    "get_style_guide",
    {
      description: "The recipe style guide (format, units, tags, stubs) plus the tags in use. Call before the first create_recipe or update_recipe.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => ({ content: [{ type: "text", text: await styleGuideText(db) }] }),
  );

  server.registerTool(
    "search_recipes",
    {
      description:
        "Find recipes. Every query word must appear in the title, an ingredient, the notes or a tag value (case-insensitive), or name one of the recipe's ingredient bases (\"apples\" finds \"red apple\"); title matches come first. Returns compact rows.",
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        tags: z.array(TagSchema).max(10).optional().describe("Full group:value tags; all must match"),
        max_total_min: z.number().int().positive().optional(),
        include_stubs: z.boolean().default(false).describe(`Include recipes tagged ${STUB_TAG}`),
        bookmarked: z.boolean().optional().describe("true: only recipes you bookmarked"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ,
    },
    async ({ query, tags = [], max_total_min, include_stubs, bookmarked, limit }) => {
      const words = queryTerms(query ?? "", buildCatalogue(await repo.loadCatalogue(db)));
      const matches = (await repo.recipeIndex(db))
        .filter((r) => {
          if (!include_stubs && r.tags.includes(STUB_TAG)) return false;
          if (!tags.every((t) => r.tags.includes(t))) return false;
          if (bookmarked && !r.bookmarks.some((b) => b.user === user)) return false;
          return max_total_min === undefined || (r.total_min !== undefined && r.total_min <= max_total_min);
        })
        .map((r) => ({ r, rank: searchRank(r, words) }))
        .filter((x): x is { r: repo.IndexedRecipe; rank: number } => x.rank !== null)
        .sort((a, b) => a.rank - b.rank)
        .map((x) => x.r);
      const results = matches.slice(0, limit).map((r) => ({
        id: r.id,
        title: r.title,
        tags: r.tags,
        total_min: r.total_min ?? null,
        ratings: ratingsByUser(r.ratings),
        bookmarked_by: bookmarkedBy(r.bookmarks),
        has_cover: r.has_cover,
        source_url: r.source_url ?? null,
      }));
      return ok({ total: matches.length, results });
    },
  );

  server.registerTool(
    "get_recipe",
    {
      description: "One recipe: structured fields (unscaled, with updated_at for update_recipe), markdown (scaled), ratings, bookmarked_by and comments.",
      inputSchema: z.object({ id: IdSchema, scale: ScaleSchema }),
      annotations: READ,
    },
    async ({ id, scale = 1 }) => {
      const recipe = await repo.getRecipe(db, id);
      if (!recipe) return notFound(id);
      const comments = (await repo.listComments(db, id)).map(({ user, body_md, created_at }) => ({ user, body_md, created_at }));
      return ok({
        recipe,
        bookmarked_by: bookmarkedBy(recipe.bookmarks),
        ...(scale !== 1 && { scale, scaled_sections: scaleSections(recipe.sections, scale) }),
        markdown: recipeToMarkdown(recipe, scale),
        comments,
        url: link(id),
      });
    },
  );

  server.registerTool(
    "list_tags",
    {
      description: "Tags in use with recipe counts, plus the tag groups: fixed values (null = free group), limits and who sets them.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => ok({ in_use: await tagCounts(db), vocabulary: VOCABULARY }),
  );

  server.registerTool(
    "create_recipe",
    {
      description: "Create a recipe that follows get_style_guide. Rejects with every problem listed, or with duplicate candidates unless confirm_duplicate is true.",
      inputSchema: z.object({
        recipe: RecipeInputSchema,
        review_notes: McpReviewNotesSchema,
        confirm_duplicate: z.boolean().default(false).describe("Set only after checking the candidates of a duplicate rejection"),
      }),
      annotations: WRITE,
    },
    async ({ recipe, review_notes, confirm_duplicate }) => {
      const result = await ingestRecipe(env, { recipe, review_notes: review_notes ?? [] }, { author: user, source: "mcp", confirmDuplicate: confirm_duplicate, now: now() });
      if (!result.ok && result.reason === "problems") return lintFailure("create_recipe", result.problems);
      if (!result.ok) {
        return fail(
          "Not saved: this looks like a recipe that already exists. Check the candidates with get_recipe; if it is really a different recipe, call create_recipe again with confirm_duplicate: true.",
          { candidates: result.candidates },
        );
      }
      const { id } = result;
      const saved = (await repo.getRecipe(db, id))!;
      return ok({ id, title: saved.title, tags: saved.tags, updated_at: saved.updated_at, url: link(id) });
    },
  );

  server.registerTool(
    "update_recipe",
    {
      description: "Replace a recipe's content with a full recipe (same rules as create_recipe). expected_updated_at must equal the current updated_at.",
      inputSchema: z.object({
        id: IdSchema,
        recipe: RecipeInputSchema,
        expected_updated_at: z.string().describe("updated_at from get_recipe"),
        review_notes: McpReviewNotesSchema.describe('Optional review flags, posted as one comment starting "Update notes:"'),
      }),
      annotations: WRITE,
    },
    async ({ id, recipe, expected_updated_at, review_notes }) => {
      const current = await repo.getRecipe(db, id);
      if (!current) return notFound(id);
      const conflict = (updatedAt: string): ToolResult =>
        fail(`Not saved: the recipe changed since ${expected_updated_at} (current updated_at: ${updatedAt}). Call get_recipe, reapply your change and retry.`, {
          current_updated_at: updatedAt,
        });
      if (current.updated_at !== expected_updated_at) return conflict(current.updated_at);
      const draft = { recipe, review_notes: review_notes ?? [] };
      const problems = draftProblems(draft, current.tags);
      if (problems.length) return lintFailure("update_recipe", problems);
      if (!(await repo.upsertRecipe(db, id, await resolveRecipe(env, withServerTags(draft)), change(), expected_updated_at))) {
        return conflict((await repo.getRecipe(db, id))?.updated_at ?? "unknown");
      }
      const comment = notesComment(id, user, "Update notes:", draft.review_notes, now());
      if (comment) await repo.putComment(db, comment);
      const saved = (await repo.getRecipe(db, id))!;
      return ok({ id, tags: saved.tags, updated_at: saved.updated_at, url: link(id) });
    },
  );

  server.registerTool(
    "set_tags",
    {
      description:
        "Add and remove tags as the user. Every tag is group:value: fixed groups take only their values, free groups (list, collection, from) any lowercase-kebab value. See list_tags.",
      inputSchema: z.object({
        id: IdSchema,
        add: z.array(z.string().max(60)).max(MAX_TAGS).default([]),
        remove: z.array(z.string().max(60)).max(MAX_TAGS).default([]),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, add: rawAdd, remove: rawRemove }) => {
      const add = rawAdd.map(renameLegacyTag);
      const remove = rawRemove.map(renameLegacyTag);
      if (!(await repo.recipeExists(db, id))) return notFound(id);
      const invalid = add.map(tagProblem).filter((p) => p !== null);
      if (invalid.length) return fail(`Not saved: ${invalid.join("; ")}. Use list_tags for the groups and the tags in use.`);
      let limits: string[] = [];
      let tooMany = false;
      const tags = await repo.updateTags(
        db,
        id,
        (current) => {
          const next = applyTagDelta(current, { add, remove });
          tooMany = next.length > MAX_TAGS && next.length > current.length;
          const before = overMax(current);
          limits = overMax(next).filter((p) => !before.includes(p));
          return tooMany || limits.length ? current : next;
        },
        change(),
      );
      if (tags === null) return notFound(id);
      if (tooMany) return fail(`Not saved: at most ${MAX_TAGS} tags.`);
      if (limits.length) return fail(`Not saved: ${limits.join("; ")}. Remove one in the same call to replace it.`);
      return ok({ id, tags });
    },
  );

  server.registerTool(
    "rate",
    {
      description: `Set your star rating (1-5) for a recipe. Replaces your earlier rating.`,
      inputSchema: z.object({ id: IdSchema, stars: StarsSchema }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, stars }) => {
      if (!(await repo.recipeExists(db, id))) return notFound(id);
      await repo.setRating(db, id, user, stars, now());
      return ok({ id, ratings: ratingsByUser((await repo.getRecipe(db, id))!.ratings) });
    },
  );

  server.registerTool(
    "set_bookmark",
    {
      description: "Bookmark a recipe for yourself (on: true) or remove your bookmark (on: false). Saying the same thing twice changes nothing.",
      inputSchema: z.object({ id: IdSchema, on: z.boolean() }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, on }) => {
      if (!(await repo.recipeExists(db, id))) return notFound(id);
      await repo.setBookmark(db, id, user, on, now());
      return ok({ id, bookmarked_by: bookmarkedBy((await repo.getRecipe(db, id))!.bookmarks) });
    },
  );

  server.registerTool(
    "add_comment",
    {
      description: "Add a markdown comment to a recipe.",
      inputSchema: z.object({ id: IdSchema, body_md: z.string().trim().min(1).max(5000) }),
      annotations: WRITE,
    },
    async ({ id, body_md }) => {
      if (!(await repo.recipeExists(db, id))) return notFound(id);
      const ts = now();
      const comment: Comment = { id: `c-${crypto.randomUUID()}`, recipe_id: id, user, body_md, created_at: ts, updated_at: ts };
      await repo.putComment(db, comment);
      return ok({ id, comment_id: comment.id });
    },
  );

  server.registerTool(
    "add_to_shopping_list",
    {
      description: "Add a recipe's ingredients to the shared shopping list at a scale, one line per ingredient tagged with the recipe.",
      inputSchema: z.object({ id: IdSchema, scale: ScaleSchema }),
      annotations: WRITE,
    },
    async ({ id, scale = 1 }) => {
      const recipe = await repo.getRecipe(db, id);
      if (!recipe) return notFound(id);
      const ingredients = scaleSections(recipe.sections, scale).flatMap((s) => s.ingredients);
      const rows = ingredientsToShopping(ingredients, recipe, () => `s-${crypto.randomUUID()}`, now());
      await repo.applyShopping(db, await placeShopping(env, rows));
      return ok({ id, scale, added: rows.length });
    },
  );

  server.registerTool(
    "set_cover_from_url",
    {
      description: "Download an https image (jpeg/png/webp, max 10 MB, max 3 redirects) and make it the recipe's cover.",
      inputSchema: z.object({
        id: IdSchema,
        image_url: z.url(),
        focus: CoverFocusSchema.optional().describe("Focal point in percent of the image; default is the app's default crop"),
      }),
      annotations: { ...WRITE, openWorldHint: true },
    },
    async ({ id, image_url, focus }) => {
      const row = await repo.getCoverKey(db, id);
      if (!row) return notFound(id);
      const image = await fetchCoverImage(image_url);
      if (!image.ok) return fail(`Not saved: ${image.message}`);
      await storeCover(env, id, row.cover_key, { bytes: image.bytes, type: image.type, ext: image.ext, focus: focus ?? null }, now());
      const saved = (await repo.getRecipe(db, id))!;
      return ok({ id, cover_key: saved.cover_key ?? null, cover_focus: saved.cover_focus });
    },
  );

  const AisleSchema = z.enum(AISLE_IDS).describe(AISLES.map((a) => `${a.id}: ${a.label}`).join("; "));

  server.registerTool(
    "lookup_ingredients",
    {
      description:
        "What ingredient items resolve to in the household catalogue: base, aisle, origin of the entry (seed, auto = classified by a model, user) and how it matched (alias, rule, unknown). Unknown items get a model-chosen base when a recipe with them is saved.",
      inputSchema: z.object({ items: z.array(z.string().trim().min(1).max(120)).min(1).max(100) }),
      annotations: READ,
    },
    async ({ items }) => {
      const data = await repo.loadCatalogue(db);
      const cat = buildCatalogue(data);
      const origin = new Map(data.bases.map((b) => [b.base, b.origin]));
      return ok({ results: items.map((item) => ({ item, ...resolveLocal(cat, item), origin: origin.get(resolveLocal(cat, item).base) ?? null })) });
    },
  );

  server.registerTool(
    "list_ingredients",
    {
      description: "The catalogue's bases with aisle, origin and aliases. Filter by origin (auto lists what a model classified, for review) or aisle.",
      inputSchema: z.object({ origin: z.enum(["seed", "auto", "user"]).optional(), aisle: AisleSchema.optional() }),
      annotations: READ,
    },
    async ({ origin, aisle }) => {
      const data = await repo.loadCatalogue(db);
      const aliases = new Map<string, string[]>();
      for (const a of data.aliases) aliases.set(a.base, [...(aliases.get(a.base) ?? []), a.alias]);
      const bases = data.bases.filter((b) => (!origin || b.origin === origin) && (!aisle || b.aisle === aisle)).map((b) => ({ ...b, aliases: aliases.get(b.base) ?? [] }));
      return ok({ total: bases.length, bases });
    },
  );

  server.registerTool(
    "set_ingredient",
    {
      description:
        "Correct the catalogue as the user: make `item` resolve to `base` (new or existing), and optionally put the base into `aisle`. Recorded with origin user; every recipe's bases are resolved again afterwards.",
      inputSchema: z.object({
        item: z.string().trim().min(1).max(120).describe('The name as recipes write it, e.g. "Granny Smith apples"'),
        base: z.string().trim().min(1).max(60).describe('The canonical base: English, lowercase, singular, e.g. "apple"'),
        aisle: AisleSchema.optional().describe("Omit to keep the base's aisle (a new base goes to other)"),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ item, base, aisle }) => {
      const entry = await repo.setUserEntry(db, { alias: storedName(item), base: storedName(base), aisle }, now());
      let cursor: string | undefined;
      let updated = 0;
      do {
        const page = await backfillBases(env, { model: false, cursor });
        updated += page.updated;
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return ok({ item, ...entry, recipes_updated: updated });
    },
  );

  return server;
}
