import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { openLocalDB } from "../src/store/idb";

let n = 0;
const names = () => ({ name: `new-${++n}`, legacy: `old-${n}` });

async function seedLegacy(legacy: string): Promise<void> {
  const d = await openDB(legacy, 1, {
    upgrade(u) {
      u.createObjectStore("kv");
      u.createObjectStore("recipes", { keyPath: "recipe.id" });
      u.createObjectStore("shopping", { keyPath: "id" });
      u.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    },
  });
  await d.put("kv", 7, "shoppingRev");
  await d.put("recipes", { recipe: { id: "r1" }, cached_at: "x" });
  await d.put("shopping", { id: "s1" });
  await d.put("outbox", { kind: "a" });
  await d.put("outbox", { kind: "b" });
  d.close();
}

async function exists(dbName: string): Promise<boolean> {
  return (await indexedDB.databases()).some((d) => d.name === dbName);
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("local database rename", () => {
  it("copies every store from the legacy database and deletes it", async () => {
    const { name, legacy } = names();
    await seedLegacy(legacy);
    const d = await openLocalDB(name, legacy);
    expect(await d.get("kv", "shoppingRev")).toBe(7);
    expect(await d.get("recipes", "r1")).toMatchObject({ cached_at: "x" });
    expect(await d.get("shopping", "s1")).toEqual({ id: "s1" });
    expect(await d.getAll("outbox")).toEqual([
      { kind: "a", seq: 1 },
      { kind: "b", seq: 2 },
    ]);
    // The autoIncrement counter continues after the copied ops.
    expect(await d.add("outbox", { kind: "c" } as never)).toBe(3);
    await settle();
    expect(await exists(legacy)).toBe(false);
  });

  it("does not copy again once adopted, even if the legacy database reappears", async () => {
    const { name, legacy } = names();
    await seedLegacy(legacy);
    (await openLocalDB(name, legacy)).close();
    await settle();
    await seedLegacy(legacy);
    const d = await openLocalDB(name, legacy);
    expect(await d.count("outbox")).toBe(2);
    await settle();
    expect(await exists(legacy)).toBe(false);
  });

  it("leaves no legacy database behind on a fresh install", async () => {
    const { name, legacy } = names();
    const d = await openLocalDB(name, legacy);
    expect(await d.count("kv")).toBe(0);
    await settle();
    expect(await exists(legacy)).toBe(false);
    expect(await exists(name)).toBe(true);
  });
});
