import { type Context, Hono } from "hono";
import { z } from "zod";
import { AISLE_IDS, buildCatalogue, type CatalogueData, storedName } from "../shared/catalogue";
import { COVER_KEY, COVER_TYPES, contentHash, MAX_COVER_BYTES, parseFocusParam } from "../shared/cover";
import { diffRecipes, type Revision, type RevisionListItem, restoredContent, summarizeDiff } from "../shared/revisions";
import {
  type Comment,
  CommentInputSchema,
  CoverFocusPatchSchema,
  CoverFocusSchema,
  ImportRecordSchema,
  type ImportResult,
  MAX_TAGS,
  type RecipeDetail,
  RecipeInputSchema,
  type ShoppingItem,
  ShoppingItemSchema,
  ShoppingSyncRequestSchema,
  type ShoppingSyncResponse,
  StarsSchema,
  TagDeltaSchema,
  toFieldErrors,
  type User,
  type ValidationErrorBody,
} from "../shared/schema";
import { searchRecipes } from "../shared/search";
import { applyTagDelta } from "../shared/tags";
import { type AuthEnv, authRoutes, PUBLIC_PATHS, requestUser, unauthenticated } from "./auth";
import { backfillBases, placeShopping, resolveRecipe } from "./catalogue";
import { storeCover } from "./covers";
import * as repo from "./repo";
import { importFromUrl, importStatus, saveImported } from "./urlImport";

/** ANTHROPIC_API_KEY (secret) enables AI import from a link; without it imports are filled without AI. */
export type Bindings = { DB: D1Database; COVERS: R2Bucket; ASSETS: Fetcher; ANTHROPIC_API_KEY?: string } & AuthEnv;
export type Env = { Bindings: Bindings; Variables: { user: User } };

const app = new Hono<Env>().basePath("/api");

/** The acting user comes from the session cookie (or the import bearer token), never from the client. */
app.use("*", async (c, next) => {
  const user = await requestUser(c.req.raw, c.env);
  if (!user) return c.json({ error: "auth_required" }, 401, { "cache-control": "no-store" });
  c.set("user", user);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: err.message }, 500);
});

const now = (): string => new Date().toISOString();

const change = (c: Context<Env>, source: repo.ContentChange["source"]): repo.ContentChange => ({ author: c.get("user"), source, now: now() });

/** Parse JSON body with a zod schema, or return a 400 with field-level errors. */
async function parseBody<T>(c: Context<Env>, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json<ValidationErrorBody>({ error: "validation", fields: { _: "Invalid JSON" } }, 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, res: c.json<ValidationErrorBody>({ error: "validation", fields: toFieldErrors(result.error.issues) }, 400) };
  }
  return { ok: true, data: result.data };
}

const newId = (prefix = ""): string => prefix + crypto.randomUUID().slice(0, 8);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------- identity ----------
app.get("/me", (c) => c.json({ user: c.get("user") }));

// ---------- recipes ----------
app.get("/recipes", async (c) => {
  const q = c.req.query("q");
  const tag = c.req.query("tag")?.toLowerCase();
  let list = await repo.listRecipes(c.env.DB);
  if (q) list = searchRecipes(list, q, buildCatalogue(await repo.loadCatalogue(c.env.DB)));
  if (tag) list = list.filter((r) => r.tags.includes(tag));
  return c.json(list);
});

app.get("/recipes/:id", async (c) => {
  const id = c.req.param("id");
  const recipe = await repo.getRecipe(c.env.DB, id);
  if (!recipe) return c.json({ error: "not_found" }, 404);
  const comments = await repo.listComments(c.env.DB, id);
  return c.json<RecipeDetail>({ recipe, comments });
});

app.post("/recipes", async (c) => {
  const body = await parseBody(c, RecipeInputSchema);
  if (!body.ok) return body.res;
  const id = await repo.freshRecipeId(c.env.DB, body.data.title);
  await repo.upsertRecipe(c.env.DB, id, await resolveRecipe(c.env, body.data), change(c, "editor"));
  return c.json(await repo.getRecipe(c.env.DB, id), 201);
});

app.put("/recipes/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await repo.recipeExists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const body = await parseBody(c, RecipeInputSchema);
  if (!body.ok) return body.res;
  await repo.upsertRecipe(c.env.DB, id, await resolveRecipe(c.env, body.data), change(c, "editor"));
  return c.json(await repo.getRecipe(c.env.DB, id));
});

app.put("/recipes/:id/rating", async (c) => {
  const id = c.req.param("id");
  if (!(await repo.recipeExists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const body = await parseBody(c, z.object({ stars: StarsSchema }));
  if (!body.ok) return body.res;
  await repo.setRating(c.env.DB, id, c.get("user"), body.data.stars, now());
  return c.json(await repo.getRecipe(c.env.DB, id));
});

app.put("/recipes/:id/bookmark", async (c) => {
  const id = c.req.param("id");
  if (!(await repo.recipeExists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const body = await parseBody(c, z.object({ on: z.boolean() }));
  if (!body.ok) return body.res;
  await repo.setBookmark(c.env.DB, id, c.get("user"), body.data.on, now());
  return c.json(await repo.getRecipe(c.env.DB, id));
});

/** Delta, not replace: `{add?, remove?}`. Adding an existing tag / removing a missing one is a no-op. */
app.patch("/recipes/:id/tags", async (c) => {
  const id = c.req.param("id");
  const body = await parseBody(c, TagDeltaSchema);
  if (!body.ok) return body.res;
  let tooMany = false;
  const tags = await repo.updateTags(
    c.env.DB,
    id,
    (current) => {
      const next = applyTagDelta(current, body.data);
      tooMany = next.length > MAX_TAGS && next.length > current.length;
      return tooMany ? current : next;
    },
    change(c, "tags"),
  );
  if (tags === null) return c.json({ error: "not_found" }, 404);
  if (tooMany) return c.json<ValidationErrorBody>({ error: "validation", fields: { add: `At most ${MAX_TAGS} tags` } }, 400);
  return c.json(await repo.getRecipe(c.env.DB, id));
});

// ---------- revisions (content + tags history, written by repo on every content change) ----------
/** Newest first. Each entry says what it changed compared with the version before it. */
app.get("/recipes/:id/revisions", async (c) => {
  const id = c.req.param("id");
  if (!(await repo.recipeExists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const revs = await repo.listRevisions(c.env.DB, id);
  const list = revs.map(({ snapshot, ...meta }, i): RevisionListItem => {
    const prev = revs[i - 1];
    return { ...meta, changes: prev ? summarizeDiff(diffRecipes(prev.snapshot, snapshot)) : [] };
  });
  return c.json(list.reverse());
});

const revParam = (c: Context<Env>): number | null => {
  const n = Number(c.req.param("rev"));
  return Number.isSafeInteger(n) ? n : null;
};

app.get("/recipes/:id/revisions/:rev", async (c) => {
  const n = revParam(c);
  const rev = n === null ? null : await repo.getRevision(c.env.DB, c.req.param("id"), n);
  return rev ? c.json<Revision>(rev) : c.json({ error: "not_found" }, 404);
});

/** Writes the revision's content and tags as current (see `restoredContent`). Idempotent: restoring the version that is already current records nothing. */
app.post("/recipes/:id/revisions/:rev/restore", async (c) => {
  const id = c.req.param("id");
  const n = revParam(c);
  const revision = n === null ? null : await repo.getRevision(c.env.DB, id, n);
  if (!revision) return c.json({ error: "not_found" }, 404);
  await repo.upsertRecipe(c.env.DB, id, await resolveRecipe(c.env, restoredContent(revision.snapshot)), change(c, "restore"));
  return c.json(await repo.getRecipe(c.env.DB, id));
});

// ---------- cover images (R2, content-addressed keys) ----------
/**
 * Raw image body. Same bytes -> same key -> no write. A new image replaces the old object and
 * resets the focal point, to `?focus=x,y` when given (the loader passes the importer's proposal).
 */
app.put("/recipes/:id/cover", async (c) => {
  const id = c.req.param("id");
  const focusQuery = c.req.query("focus");
  const focus = focusQuery === undefined ? null : CoverFocusSchema.safeParse(parseFocusParam(focusQuery));
  if (focus && !focus.success) return c.json<ValidationErrorBody>({ error: "validation", fields: { focus: "Expected x,y in 0-100" } }, 400);
  const row = await repo.getCoverKey(c.env.DB, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = COVER_TYPES[type];
  if (!ext) return c.json({ error: "unsupported_media_type", message: `Expected one of ${Object.keys(COVER_TYPES).join(", ")}` }, 415);
  if (Number(c.req.header("content-length") ?? 0) > MAX_COVER_BYTES) return c.json({ error: "too_large", message: "Max 10 MB" }, 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_COVER_BYTES) return c.json({ error: "too_large", message: "Max 10 MB" }, 413);
  if (bytes.byteLength === 0) return c.json<ValidationErrorBody>({ error: "validation", fields: { _: "Empty image" } }, 400);
  await storeCover(c.env, id, row.cover_key, { bytes, type, ext, focus: focus?.data ?? null }, now());
  return c.json(await repo.getRecipe(c.env.DB, id));
});

/** Set (or with null, reset) the focal point. Plain overwrite: replays are harmless, the last write wins. */
app.patch("/recipes/:id/cover-focus", async (c) => {
  const id = c.req.param("id");
  const body = await parseBody(c, CoverFocusPatchSchema);
  if (!body.ok) return body.res;
  if (!(await repo.setCoverFocus(c.env.DB, id, body.data.cover_focus, "user", now()))) return c.json({ error: "not_found" }, 404);
  return c.json(await repo.getRecipe(c.env.DB, id));
});

/** `/api/<cover_key>`. Keys never change content, so the browser (and the SW) may keep them forever. */
app.get("/covers/*", async (c) => {
  const key = c.req.path.slice("/api/".length);
  if (!COVER_KEY.test(key)) return c.json({ error: "not_found" }, 404);
  const obj = await c.env.COVERS.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
      etag: obj.httpEtag,
      "x-content-type-options": "nosniff",
    },
  });
});

// ---------- bulk import (idempotent upsert keyed by source_ref) ----------
/**
 * An unchanged record (same hash as the last import) writes nothing, so re-running the loader
 * neither churns updated_at nor undoes edits made in the app since the last import.
 */
app.put("/import/:source_ref", async (c) => {
  const ref = c.req.param("source_ref");
  const body = await parseBody(c, ImportRecordSchema);
  if (!body.ok) return body.res;
  const rec = body.data;
  if (rec.source_ref !== ref) {
    return c.json<ValidationErrorBody>({ error: "validation", fields: { source_ref: "Does not match the URL" } }, 400);
  }
  const hash = await contentHash(utf8(JSON.stringify(rec)));
  const existing = await repo.findBySourceRef(c.env.DB, ref);
  if (existing?.import_hash === hash) {
    return c.json<ImportResult>({ id: existing.id, status: "unchanged", cover_key: existing.cover_key });
  }
  const id = existing?.id ?? (await repo.freshRecipeId(c.env.DB, rec.recipe.title));
  const seen = new Map<string, number>();
  const comments = await Promise.all(
    rec.comments.map(async (cm) => {
      const created_at = new Date(cm.created_at).toISOString();
      const base = `${ref}|${created_at}|${cm.user}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = `imp-${await contentHash(utf8(n ? `${base}#${n}` : base))}`;
      return { id, user: cm.user, body_md: cm.body_md, created_at };
    }),
  );
  await repo.applyImport(c.env.DB, id, { ...rec, recipe: await resolveRecipe(c.env, rec.recipe) }, comments, hash, change(c, "import"));
  return c.json<ImportResult>({ id, status: existing ? "updated" : "created", cover_key: existing?.cover_key ?? null }, existing ? 200 : 201);
});

// ---------- import from a link (draft first, saved only from the editor) ----------
app.get("/import-url/status", (c) => importStatus(c));
app.post("/import-url", (c) => importFromUrl(c));
app.post("/import-url/save", (c) => saveImported(c));

// ---------- comments (client-generated ids -> idempotent PUT, safe to replay) ----------
app.put("/comments/:id", async (c) => {
  const id = c.req.param("id");
  const body = await parseBody(c, CommentInputSchema.extend({ created_at: z.iso.datetime().optional() }));
  if (!body.ok) return body.res;
  const user = c.get("user");
  const existing = await repo.getComment(c.env.DB, id);
  if (existing && existing.user !== user) return c.json({ error: "forbidden" }, 403);
  if (!existing && !(await repo.recipeExists(c.env.DB, body.data.recipe_id))) return c.json({ error: "not_found" }, 404);
  const ts = now();
  const comment: Comment = {
    id,
    recipe_id: existing?.recipe_id ?? body.data.recipe_id,
    user,
    body_md: body.data.body_md,
    created_at: existing?.created_at ?? body.data.created_at ?? ts,
    updated_at: ts,
  };
  await repo.putComment(c.env.DB, comment);
  return c.json(comment);
});

app.delete("/comments/:id", async (c) => {
  const existing = await repo.getComment(c.env.DB, c.req.param("id"));
  if (!existing) return c.body(null, 204); // idempotent
  if (existing.user !== c.get("user")) return c.json({ error: "forbidden" }, 403);
  await repo.deleteComment(c.env.DB, existing.id);
  return c.body(null, 204);
});

// ---------- shopping list ----------
/** Normalize timestamps so string comparison in SQL is a valid time comparison. */
const normalize = (i: ShoppingItem): ShoppingItem => ({ ...i, updated_at: new Date(i.updated_at).toISOString() });

app.get("/shopping", async (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  return c.json(await repo.shoppingSince(c.env.DB, since));
});

/**
 * The endpoint the client outbox uses: push a batch (and a reordered aisle list), get back
 * everything after `since`, the aisle order, and the catalogue version to refetch it when it moved.
 */
app.post("/shopping/sync", async (c) => {
  const body = await parseBody(c, ShoppingSyncRequestSchema);
  if (!body.ok) return body.res;
  const { items, since, aisle_order } = body.data;
  await repo.applyShopping(c.env.DB, await placeShopping(c.env, items.map(normalize)));
  if (aisle_order) await repo.putAisleOrder(c.env.DB, { ...aisle_order, updated_at: new Date(aisle_order.updated_at).toISOString() });
  const [list, order, version] = await Promise.all([repo.shoppingSince(c.env.DB, since), repo.getAisleOrder(c.env.DB), repo.catalogueVersion(c.env.DB)]);
  return c.json<ShoppingSyncResponse>({ ...list, aisle_order: order, catalogue_version: version });
});

// Thin REST helpers (handy for curl and for non-offline clients). Same LWW path.
const AddItemSchema = ShoppingItemSchema.omit({ id: true, updated_at: true, checked: true, deleted: true });

app.post("/shopping", async (c) => {
  const body = await parseBody(c, AddItemSchema);
  if (!body.ok) return body.res;
  const [item] = await placeShopping(c.env, [{ ...body.data, id: newId("s-"), checked: false, updated_at: now() }]);
  await repo.applyShopping(c.env.DB, [item!]);
  return c.json(item, 201);
});

app.patch("/shopping/:id", async (c) => {
  const existing = await repo.getShopping(c.env.DB, c.req.param("id"));
  if (!existing || existing.deleted) return c.json({ error: "not_found" }, 404);
  const body = await parseBody(c, z.object({ checked: z.boolean().optional(), deleted: z.boolean().optional() }));
  if (!body.ok) return body.res;
  const next: ShoppingItem = { ...existing, ...body.data, updated_at: now() };
  await repo.applyShopping(c.env.DB, [next]);
  return c.json(next);
});

// ---------- ingredient catalogue ----------
app.get("/catalogue", async (c) => c.json<CatalogueData>(await repo.loadCatalogue(c.env.DB)));

/** A person moved a base to another aisle (the shopping list's "move"). Plain overwrite, safe to replay. */
app.put("/catalogue/bases/:base", async (c) => {
  const base = storedName(c.req.param("base"));
  const body = await parseBody(c, z.object({ aisle: z.enum(AISLE_IDS), updated_at: z.string().datetime().optional() }));
  if (!body.ok) return body.res;
  if (!base) return c.json<ValidationErrorBody>({ error: "validation", fields: { base: "Empty base" } }, 400);
  await repo.setBaseAisle(c.env.DB, base, body.data.aisle, body.data.updated_at ?? "1970-01-01T00:00:00.000Z");
  return c.json({ base, aisle: body.data.aisle });
});

/**
 * Resolves every recipe's ingredient bases again (with the model for unknown items when it is
 * available). Idempotent and safe to rerun; also accepts IMPORT_TOKEN, so it can run from a shell.
 */
app.put("/catalogue/backfill", async (c) => c.json(await backfillBases(c.env, { model: true, cursor: c.req.query("cursor") })));

app.notFound((c) => c.json({ error: "not_found" }, 404));

/**
 * Everything that is not OAuth or MCP (see index.ts). Login covers the static assets too
 * (assets.run_worker_first: true). /api goes to Hono and everything else to the assets binding,
 * which still applies the SPA fallback (deep links get index.html).
 */
export const appHandler = {
  async fetch(req, env, ctx) {
    const handled = await authRoutes(req, env);
    if (handled) return handled;
    const { pathname } = new URL(req.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return app.fetch(req, env, ctx);
    if (PUBLIC_PATHS.has(pathname) || (await requestUser(req, env))) return env.ASSETS.fetch(req);
    return unauthenticated(req);
  },
} satisfies ExportedHandler<Bindings>;
