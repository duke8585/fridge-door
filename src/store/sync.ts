import type { AisleOrder } from "../../shared/catalogue";
import type { ShoppingItem, ShoppingSyncResponse } from "../../shared/schema";
import { upgradeTag } from "../../shared/tags";
import { ApiError, AuthError, api, NetworkError } from "../lib/api";
import { recipesToKeep } from "../lib/offlineRecipes";
import { signal } from "../lib/signal";
import { currentUser, refreshUser } from "../lib/user";
import { applyRemoteAisleOrder } from "./aisles";
import { refreshCatalogue } from "./catalogue";
import { kvGet, kvSet, type QueuedOp } from "./idb";
import { allOps, onEnqueue, refreshPending, removeOps } from "./outbox";
import { cacheRecipes, loadSummaries, refreshOpenRecipes, summaries } from "./recipes";
import { applyRemoteShopping, shopping } from "./shopping";

/** `authRequired`: the server answered 401 (session expired); ops stay queued until login. */
export type SyncStatus = { online: boolean; syncing: boolean; authRequired?: boolean; lastOkAt?: string; lastError?: string };
export const syncStatus = signal<SyncStatus>({ online: navigator.onLine, syncing: false });

/** Changes the server refused (4xx) and that were dropped from the outbox. Shown in the header until dismissed. */
export type Rejected = { count: number; last?: string };
export const rejected = signal<Rejected>({ count: 0 });

function reportRejected(n: number, reason: string): void {
  console.warn("dropping rejected op(s)", n, reason);
  rejected.update((r) => ({ count: r.count + n, last: reason }));
}

export function dismissRejected(): void {
  rejected.set({ count: 0 });
}

const POLL_MS = 4000;
const RECIPE_POLL_EVERY = 3; // recipes every 3rd tick (~12 s)
const LIST_POLL_EVERY = 30; // the library list every 30th tick (~2 min): it carries the bookmarks to keep offline

/** Recipe ids with a mounted view; the poller refreshes these. */
export const openRecipes = new Set<string>();

let running: Promise<void> | undefined;
let again = false;

/** Push the outbox, then pull shopping changes. Coalesces concurrent calls. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again);
  })().finally(() => {
    running = undefined;
  });
  return running;
}

async function syncOnce(): Promise<void> {
  syncStatus.update((s) => ({ ...s, syncing: true }));
  try {
    const ops = await allOps();
    const listOp = (o: QueuedOp): boolean => o.kind === "shopping" || o.kind === "aisle.order";
    await pushShoppingAndPull(ops.filter(listOp));
    for (const op of ops) {
      if (!listOp(op)) await pushOne(op);
    }
    syncStatus.set({ online: true, syncing: false, lastOkAt: new Date().toISOString() });
  } catch (e) {
    const offline = e instanceof NetworkError;
    const authRequired = e instanceof AuthError;
    syncStatus.update((s) => ({ ...s, online: !offline, authRequired, syncing: false, lastError: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * One round trip: send the latest local version of each queued item and the latest aisle reorder,
 * receive everything since our cursor, the aisle order and the catalogue version.
 */
async function pushShoppingAndPull(ops: QueuedOp[]): Promise<void> {
  const latest = new Map<string, ShoppingItem>();
  let order: AisleOrder | undefined;
  for (const op of ops) {
    if (op.kind === "shopping") latest.set(op.item.id, op.item);
    if (op.kind === "aisle.order") order = op.order;
  }
  const since = (await kvGet<number>("shoppingRev")) ?? 0;
  let res: ShoppingSyncResponse;
  try {
    res = await api<ShoppingSyncResponse>("/shopping/sync", { method: "POST", json: { items: [...latest.values()], since, aisle_order: order } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      // A bad row would block the queue forever; drop the batch and report it in the header.
      await removeOps(ops.map((o) => o.seq!));
      reportRejected(Math.max(1, latest.size), `Shopping list change rejected: ${JSON.stringify(e.fields)}`);
      return;
    }
    throw e;
  }
  await removeOps(ops.map((o) => o.seq!));
  await applyRemoteShopping(res.items);
  await kvSet("shoppingRev", res.rev);
  await applyRemoteAisleOrder(res.aisle_order);
  // a failed catalogue fetch is retried on the next poll; it says nothing about the list sync
  if (res.catalogue_version) await refreshCatalogue(res.catalogue_version).catch((e: unknown) => console.warn("catalogue refresh failed", e));
}

async function pushOne(op: QueuedOp): Promise<void> {
  try {
    switch (op.kind) {
      case "rating":
        await api(`/recipes/${op.recipe_id}/rating`, { method: "PUT", json: { stars: op.stars } });
        break;
      case "bookmark":
        await api(`/recipes/${op.recipe_id}/bookmark`, { method: "PUT", json: { on: op.on } });
        break;
      case "tags.delta":
        await api(`/recipes/${op.recipe_id}/tags`, { method: "PATCH", json: { add: op.add.map(upgradeTag), remove: op.remove.map(upgradeTag) } });
        break;
      case "cover.focus":
        await api(`/recipes/${op.recipe_id}/cover-focus`, { method: "PATCH", json: { cover_focus: op.focus } });
        break;
      case "comment.put":
        await api(`/comments/${op.comment.id}`, {
          method: "PUT",
          json: { recipe_id: op.comment.recipe_id, body_md: op.comment.body_md, created_at: op.comment.created_at },
        });
        break;
      case "comment.delete":
        await api(`/comments/${op.id}`, { method: "DELETE" });
        break;
      case "catalogue.aisle":
        await api(`/catalogue/bases/${encodeURIComponent(op.base)}`, {
          method: "PUT",
          json: { aisle: op.aisle, updated_at: op.updated_at ?? "1970-01-01T00:00:00.000Z" },
        });
        break;
    }
  } catch (e) {
    // 4xx = server will never accept it: drop and report. Network/5xx/401 (login expired): keep and stop this round.
    if (e instanceof AuthError || !(e instanceof ApiError && e.status >= 400 && e.status < 500)) throw e;
    reportRejected(1, `${describeOp(op)} rejected (${e.status} ${e.message})`);
  }
  await removeOps([op.seq!]);
}

function describeOp(op: QueuedOp): string {
  switch (op.kind) {
    case "rating":
      return "Rating";
    case "bookmark":
      return "Bookmark";
    case "tags.delta":
      return "Tag change";
    case "cover.focus":
      return "Cover crop";
    case "comment.put":
      return "Comment";
    case "comment.delete":
      return "Comment delete";
    case "catalogue.aisle":
      return "Aisle move";
    default:
      return "Change";
  }
}

let started = false;

export function startSync(): void {
  if (started) return;
  started = true;
  let tick = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  onEnqueue(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void syncNow(), 250);
  });
  const poll = async (): Promise<void> => {
    if (document.visibilityState !== "visible") return;
    await syncNow();
    if (++tick % RECIPE_POLL_EVERY !== 0 || !syncStatus.get().online) return;
    await refreshOpenRecipes(openRecipes);
    if (tick % LIST_POLL_EVERY === 0 || !summaries.get()) await loadSummaries();
    // the recipes on the shopping list and the bookmarked ones must open offline, also when added on another device
    const onList = [...shopping.get().values()].flatMap((i) => (!i.deleted && i.recipe_id ? [i.recipe_id] : []));
    await cacheRecipes(recipesToKeep(onList, summaries.get(), currentUser.get())).catch((e: unknown) => console.warn("caching offline recipes failed", e));
  };
  setInterval(() => void poll(), POLL_MS);
  window.addEventListener("online", () => void syncNow());
  window.addEventListener("offline", () => syncStatus.update((s) => ({ ...s, online: false })));
  document.addEventListener("visibilitychange", () => void poll());
  void refreshPending();
  void refreshUser();
  void syncNow();
}
