import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { RecipeDetail, RecipeSummary, ShoppingItem } from "../../shared/schema";
import type { OutboxOp } from "./ops";

export type QueuedOp = OutboxOp & { seq?: number };

/** Everything the UI reads lives here; network only refreshes it. */
interface LocalDB extends DBSchema {
  kv: { key: string; value: unknown };
  recipes: { key: string; value: RecipeDetail & { cached_at: string } };
  shopping: { key: string; value: ShoppingItem };
  outbox: { key: number; value: QueuedOp };
}

const DB_NAME = "fridge-door";
/**
 * The app was called "recipes-spa" until 2026-11 and kept its local data under that name.
 * openLocalDB copies that database into DB_NAME once and deletes it, so unsynced outbox ops survive
 * the rename. Drop this once every device has opened the app since then.
 */
const LEGACY_DB_NAME = "recipes-spa";
/** Written in the same transaction as the copy, so a reload between copy and delete never copies twice. */
const ADOPTED_KEY = "adoptedLegacyDB";
const STORES = ["kv", "recipes", "shopping", "outbox"] as const;

let dbp: Promise<IDBPDatabase<LocalDB>> | undefined;

export function db(): Promise<IDBPDatabase<LocalDB>> {
  dbp ??= openLocalDB(DB_NAME, LEGACY_DB_NAME);
  return dbp;
}

export async function openLocalDB(name: string, legacyName: string): Promise<IDBPDatabase<LocalDB>> {
  const fresh = await openDB<LocalDB>(name, 1, {
    upgrade(d) {
      d.createObjectStore("kv");
      d.createObjectStore("recipes", { keyPath: "recipe.id" });
      d.createObjectStore("shopping", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    },
  });
  await adoptLegacy(fresh, legacyName);
  return fresh;
}

async function adoptLegacy(fresh: IDBPDatabase<LocalDB>, legacyName: string): Promise<void> {
  // Opening without a version never upgrades an existing database; a missing one comes back
  // empty (no stores) and is deleted below.
  const legacy = await openDB(legacyName);
  try {
    if (legacy.objectStoreNames.length === 0 || (await fresh.get("kv", ADOPTED_KEY))) return;
    const rows = await Promise.all(
      STORES.map(async (s) => ({ store: s, keys: await legacy.getAllKeys(s), values: await legacy.getAll(s) })),
    );
    const tx = fresh.transaction(STORES, "readwrite");
    for (const { store, keys, values } of rows) {
      // kv keeps its keys out of line; the other stores carry them in the value.
      if (store === "kv") values.forEach((v, i) => void tx.objectStore("kv").put(v, keys[i] as string));
      else values.forEach((v) => void tx.objectStore(store).put(v as never));
    }
    void tx.objectStore("kv").put(true, ADOPTED_KEY);
    await tx.done;
  } finally {
    legacy.close();
    // Not awaited: a tab still running the old build keeps the legacy database open, and the
    // delete waits for it to close. The app must not wait with it.
    void deleteDB(legacyName).catch(() => {});
  }
}

export type KvKey = "summaries" | "shoppingRev" | "catalogue" | "aisleOrder";

export async function kvGet<T>(key: KvKey): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function kvSet(key: KvKey, value: unknown): Promise<void> {
  await (await db()).put("kv", value, key);
}

export type { RecipeSummary };
