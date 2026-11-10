import type { Aisle } from "../../shared/catalogue";
import type { ShoppingItem } from "../../shared/schema";
import { mergeRemote, nextTimestamp, placeOf } from "../../shared/shopping";
import { signal } from "../lib/signal";
import { catalogue, setLocalAisle } from "./catalogue";
import { db } from "./idb";
import { enqueue } from "./outbox";

/** In-memory mirror of the IndexedDB "shopping" store (incl. tombstones). */
export const shopping = signal<ReadonlyMap<string, ShoppingItem>>(new Map());

export async function loadShopping(): Promise<void> {
  const rows = await (await db()).getAll("shopping");
  shopping.set(new Map(rows.map((r) => [r.id, r])));
}

/** Local write: update memory + IndexedDB, queue for the server. */
async function writeLocal(items: ShoppingItem[]): Promise<void> {
  if (items.length === 0) return;
  const next = new Map(shopping.get());
  for (const i of items) next.set(i.id, i);
  shopping.set(next);
  const tx = (await db()).transaction("shopping", "readwrite");
  await Promise.all([...items.map((i) => tx.store.put(i)), tx.done]);
  await enqueue(...items.map((item) => ({ kind: "shopping" as const, item })));
}

function touch(i: ShoppingItem, patch: Partial<ShoppingItem>): ShoppingItem {
  return { ...i, ...patch, updated_at: nextTimestamp(i.updated_at) };
}

export function addShoppingItems(items: ShoppingItem[]): Promise<void> {
  return writeLocal(items);
}

export function toggleItem(id: string): Promise<void> {
  const i = shopping.get().get(id);
  return i ? writeLocal([touch(i, { checked: !i.checked })]) : Promise.resolve();
}

const groupLines = (base: string): ShoppingItem[] => [...shopping.get().values()].filter((i) => !i.deleted && placeOf(i, catalogue.get()).base === base);

export function setGroupChecked(base: string, checked: boolean): Promise<void> {
  return writeLocal(groupLines(base).filter((i) => i.checked !== checked).map((i) => touch(i, { checked })));
}

/**
 * Move a group to another aisle: its lines move now (synced like any edit), and the catalogue learns
 * it as a user entry, so the next item with this base lands there too.
 */
export async function moveToAisle(base: string, aisle: Aisle): Promise<void> {
  setLocalAisle(base, aisle);
  await writeLocal(groupLines(base).map((i) => touch(i, { base, aisle })));
  await enqueue({ kind: "catalogue.aisle", base, aisle, updated_at: new Date().toISOString() });
}

export function removeItem(id: string): Promise<void> {
  const i = shopping.get().get(id);
  return i ? writeLocal([touch(i, { deleted: true })]) : Promise.resolve();
}

/** Every item that came from the recipe, ticked or not; items typed in by hand have no recipe_id. */
export function removeRecipe(recipeId: string): Promise<void> {
  const items = [...shopping.get().values()].filter((i) => i.recipe_id === recipeId && !i.deleted);
  return writeLocal(items.map((i) => touch(i, { deleted: true })));
}

export function clearAll(): Promise<void> {
  const items = [...shopping.get().values()].filter((i) => !i.deleted);
  return writeLocal(items.map((i) => touch(i, { deleted: true })));
}

export function clearChecked(): Promise<void> {
  const items = [...shopping.get().values()].filter((i) => i.checked && !i.deleted);
  return writeLocal(items.map((i) => touch(i, { deleted: true })));
}

/** Merge rows from the server (LWW on updated_at) and persist the winners. */
export async function applyRemoteShopping(remote: ShoppingItem[]): Promise<void> {
  if (remote.length === 0) return;
  const next = new Map(shopping.get());
  const changed = mergeRemote(next, remote);
  if (changed.length === 0) return;
  shopping.set(next);
  const tx = (await db()).transaction("shopping", "readwrite");
  await Promise.all([...changed.map((id) => tx.store.put(next.get(id)!)), tx.done]);
}
