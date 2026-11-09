import { openDB, type DBSchema, type IDBPDatabase } from "idb";
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

let dbp: Promise<IDBPDatabase<LocalDB>> | undefined;

export function db(): Promise<IDBPDatabase<LocalDB>> {
  dbp ??= openDB<LocalDB>("recipes-spa", 1, {
    upgrade(d) {
      d.createObjectStore("kv");
      d.createObjectStore("recipes", { keyPath: "recipe.id" });
      d.createObjectStore("shopping", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    },
  });
  return dbp;
}

export async function kvGet<T>(key: "summaries" | "shoppingRev"): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function kvSet(key: "summaries" | "shoppingRev", value: unknown): Promise<void> {
  await (await db()).put("kv", value, key);
}

export type { RecipeSummary };
