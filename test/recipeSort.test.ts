import { describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../shared/schema";
import { BOOKMARKS_SORT, compareRecipes, loadSort, nextSort, type Sort } from "../src/lib/recipeSort";

const r = (title: string, avg_rating: number | null, created_at: string, updated_at: string, bookmarks: Bookmark[] = []) => ({ title, avg_rating, created_at, updated_at, bookmarks });
const list = [
  r("banana bread", null, "2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"),
  r("Apple cake", 4, "2026-11-02T00:00:00.000Z", "2026-11-05T00:00:00.000Z"),
  r("Curry", 4.5, "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"),
  r("Dal", null, "2026-11-03T00:00:00.000Z", "2026-11-09T00:00:00.000Z"),
  r("Eggs", 4, "2026-11-04T00:00:00.000Z", "2026-11-01T00:00:00.000Z"),
];
const order = (id: Sort["id"], dir: Sort["dir"] = id === "az" ? "asc" : "desc") => [...list].sort(compareRecipes({ id, dir }, "max")).map((x) => x.title);

describe("compareRecipes", () => {
  it("rating: highest average first, equal averages by title, unrated last (also by title)", () => {
    expect(order("rating")).toEqual(["Curry", "Apple cake", "Eggs", "banana bread", "Dal"]);
  });
  it("modified and added: newest first, ties by title ignoring case", () => {
    expect(order("modified")).toEqual(["Dal", "Apple cake", "banana bread", "Curry", "Eggs"]);
    expect(order("added")).toEqual(["Eggs", "Dal", "Apple cake", "Curry", "banana bread"]);
  });
  it("A-Z ignores case", () => {
    expect(order("az")).toEqual(["Apple cake", "banana bread", "Curry", "Dal", "Eggs"]);
  });
  it("ascending reverses the key but keeps unrated last and ties by title", () => {
    expect(order("rating", "asc")).toEqual(["Apple cake", "Eggs", "Curry", "banana bread", "Dal"]);
    expect(order("modified", "asc")).toEqual(["Eggs", "Curry", "Apple cake", "banana bread", "Dal"]);
    expect(order("az", "desc")).toEqual(["Eggs", "Dal", "Curry", "banana bread", "Apple cake"]);
  });
  it("clicking the active sort flips it, another starts in its first direction", () => {
    expect(nextSort({ id: "modified", dir: "desc" }, "modified")).toEqual({ id: "modified", dir: "asc" });
    expect(nextSort({ id: "modified", dir: "asc" }, "rating")).toEqual({ id: "rating", dir: "desc" });
    expect(nextSort({ id: "rating", dir: "desc" }, "az")).toEqual({ id: "az", dir: "asc" });
  });
  it("saved: my bookmark time, newest first, recipes I did not bookmark last", () => {
    const at = (user: "max" | "partner", day: number): Bookmark => ({ user, at: `2026-11-0${day}T00:00:00.000Z` });
    const saved = [
      r("Apple cake", null, "", "", [at("max", 2)]),
      r("Curry", null, "", "", [at("partner", 9), at("max", 5)]),
      r("Dal", null, "", "", [at("partner", 8)]),
      r("Eggs", null, "", "", [at("max", 2)]),
    ];
    const titles = (dir: Sort["dir"]) => [...saved].sort(compareRecipes({ id: "saved", dir }, "max")).map((x) => x.title);
    expect(titles("desc")).toEqual(["Curry", "Apple cake", "Eggs", "Dal"]);
    expect(titles("asc")).toEqual(["Apple cake", "Eggs", "Curry", "Dal"]);
    expect([...saved].sort(compareRecipes(BOOKMARKS_SORT, "partner")).map((x) => x.title)).toEqual(["Curry", "Dal", "Apple cake", "Eggs"]);
  });
  it("saved is never the remembered sort", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    store.set("fd_sort", "saved:desc");
    expect(loadSort()).toEqual({ id: "modified", dir: "desc" });
    vi.unstubAllGlobals();
  });
});
