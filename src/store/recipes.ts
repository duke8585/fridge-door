import { newId } from "../lib/id";
import type { Comment, CoverFocus, Rating, RecipeDetail, RecipeSummary, Stars, User } from "../../shared/schema";
import { api, ApiError, AuthError, NetworkError } from "../lib/api";
import { signal, type Signal } from "../lib/signal";
import { db, kvGet, kvSet } from "./idb";
import { upgradeTags } from "../../shared/tags";
import { applyOp, applyOpToSummary, opRecipeId, type OutboxOp } from "./ops";
import { allOps, enqueue } from "./outbox";
import { recipesToCache } from "../lib/offlineRecipes";

// ---------- list ----------
export const summaries = signal<RecipeSummary[] | undefined>(undefined);

/**
 * A list cached by an older build may lack the search fields and still have tags from before the
 * groups; it is shown upgraded until the fresh list arrives.
 */
const fromCache = (r: RecipeSummary): RecipeSummary => ({
  ...r,
  tags: upgradeTags(r.tags),
  ingredients: r.ingredients ?? [],
  notes_md: r.notes_md ?? "",
  bookmarks: r.bookmarks ?? [],
});

export async function loadSummaries(): Promise<void> {
  const cached = await kvGet<RecipeSummary[]>("summaries");
  if (cached && !summaries.get()) {
    const ops = await allOps();
    summaries.set(cached.map((r) => ops.reduce(applyOpToSummary, fromCache(r))));
  }
  try {
    const fresh = await api<RecipeSummary[]>("/recipes");
    await kvSet("summaries", fresh);
    const ops = await allOps();
    summaries.set(fresh.map((r) => ops.reduce(applyOpToSummary, r)));
  } catch {
    /* offline: keep cached */
  }
}

// ---------- detail ----------
/** Why the last network refresh failed. Shown on its own when nothing is cached, as a notice otherwise. */
export type LoadError = { kind: "offline" } | { kind: "auth" } | { kind: "server"; status: number; message: string };
export type DetailState = { detail?: RecipeDetail; missing?: boolean; error?: LoadError };

export function toLoadError(e: unknown): LoadError {
  if (e instanceof NetworkError) return { kind: "offline" };
  if (e instanceof AuthError) return { kind: "auth" };
  if (e instanceof ApiError) return { kind: "server", status: e.status, message: e.message };
  return { kind: "server", status: 0, message: e instanceof Error ? e.message : String(e) };
}
const details = new Map<string, Signal<DetailState>>();

export function detailSignal(id: string): Signal<DetailState> {
  let s = details.get(id);
  if (!s) {
    s = signal<DetailState>({});
    details.set(id, s);
  }
  return s;
}

async function withPending(d: RecipeDetail): Promise<RecipeDetail> {
  const ops = (await allOps()).filter((op) => opRecipeId(op) === d.recipe.id);
  return ops.reduce(applyOp, d);
}

async function store(d: RecipeDetail): Promise<void> {
  await (await db()).put("recipes", { ...d, cached_at: new Date().toISOString() });
}

/** Cache-first read, then revalidate from the network. Pending ops are re-applied on top. */
export async function loadRecipe(id: string): Promise<void> {
  const s = detailSignal(id);
  if (!s.get().detail) {
    const cached = await (await db()).get("recipes", id);
    if (cached) s.set({ detail: await withPending({ ...cached, recipe: { ...cached.recipe, tags: upgradeTags(cached.recipe.tags), bookmarks: cached.recipe.bookmarks ?? [] } }) });
  }
  await refreshRecipe(id);
}

export async function refreshRecipe(id: string): Promise<void> {
  const s = detailSignal(id);
  try {
    const fresh = await api<RecipeDetail>(`/recipes/${encodeURIComponent(id)}`);
    await store(fresh);
    s.set({ detail: await withPending(fresh) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) s.set({ missing: true });
    else s.set({ detail: s.get().detail, error: toLoadError(e) });
  }
}

/** Called after the editor saved successfully online. */
export async function replaceRecipe(d: RecipeDetail): Promise<void> {
  await store(d);
  detailSignal(d.recipe.id).set({ detail: await withPending(d) });
}

/** Cache the given recipes for offline use (see recipesToCache). Stops at the first failure; the next sync retries. */
export async function cacheRecipes(ids: readonly string[]): Promise<void> {
  const d = await db();
  const cached = new Map<string, string>();
  for (const id of new Set(ids)) {
    const hit = await d.get("recipes", id);
    if (hit) cached.set(id, hit.recipe.updated_at);
  }
  const list = summaries.get();
  const listed = list && new Map(list.map((r) => [r.id, r.updated_at]));
  for (const id of recipesToCache(ids, cached, listed)) {
    await store(await api<RecipeDetail>(`/recipes/${encodeURIComponent(id)}`));
  }
}

export async function recentlyCached(): Promise<string[]> {
  return (await db()).getAllKeys("recipes");
}

// ---------- optimistic mutations (go through the outbox) ----------
async function mutate(id: string, op: OutboxOp): Promise<void> {
  const s = detailSignal(id);
  const d = s.get().detail;
  let ratings: Rating[] | undefined;
  if (d) {
    const next = applyOp(d, op);
    s.set({ detail: next });
    ratings = next.recipe.ratings;
    await store(next); // ops are idempotent, so re-applying them later is harmless
  }
  patchSummary(id, (r) => {
    const patched = applyOpToSummary(r, op);
    if (op.kind !== "rating" || !ratings) return patched;
    const avg = ratings.reduce((sum, x) => sum + x.stars, 0) / ratings.length;
    return { ...patched, avg_rating: Math.round(avg * 10) / 10, rating_count: ratings.length };
  });
  await enqueue(op);
}

/** The library list follows local edits at once (tags, crop, modified time, rating, bookmark), also offline. */
function patchSummary(id: string, patch: (r: RecipeSummary) => RecipeSummary): void {
  const list = summaries.get();
  if (list?.some((r) => r.id === id)) summaries.set(list.map((r) => (r.id === id ? patch(r) : r)));
}

export const rate = (id: string, user: User, stars: Stars): Promise<void> => mutate(id, { kind: "rating", recipe_id: id, user, stars });

const nowIso = (): string => new Date().toISOString();

export const setBookmark = (id: string, user: User, on: boolean): Promise<void> => mutate(id, { kind: "bookmark", recipe_id: id, user, on, at: nowIso() });

export const addTag = (id: string, user: User, tag: string): Promise<void> =>
  mutate(id, { kind: "tags.delta", recipe_id: id, user, add: [tag], remove: [], at: nowIso() });

export const removeTag = (id: string, user: User, tag: string): Promise<void> =>
  mutate(id, { kind: "tags.delta", recipe_id: id, user, add: [], remove: [tag], at: nowIso() });

export const setCoverFocus = (id: string, user: User, focus: CoverFocus | null): Promise<void> =>
  mutate(id, { kind: "cover.focus", recipe_id: id, user, focus, at: nowIso() });

export function putComment(recipeId: string, user: User, body_md: string, existing?: Comment): Promise<void> {
  const ts = new Date().toISOString();
  const comment: Comment = existing
    ? { ...existing, body_md, updated_at: ts }
    : { id: newId(), recipe_id: recipeId, user, body_md, created_at: ts, updated_at: ts };
  return mutate(recipeId, { kind: "comment.put", comment });
}

export const deleteComment = (recipeId: string, user: User, id: string): Promise<void> =>
  mutate(recipeId, { kind: "comment.delete", id, recipe_id: recipeId, user });

/** Re-fetch every recipe that currently has a mounted view (used by the poller). */
export async function refreshOpenRecipes(ids: Iterable<string>): Promise<void> {
  await Promise.all([...ids].map((id) => refreshRecipe(id)));
}
