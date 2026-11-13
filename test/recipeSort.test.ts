import { describe, expect, it } from "vitest";
import { compareRecipes, nextSort, type Sort } from "../src/lib/recipeSort";

const r = (title: string, avg_rating: number | null, created_at: string, updated_at: string) => ({ title, avg_rating, created_at, updated_at });
const list = [
  r("banana bread", null, "2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"),
  r("Apple cake", 4, "2026-11-02T00:00:00.000Z", "2026-11-05T00:00:00.000Z"),
  r("Curry", 4.5, "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"),
  r("Dal", null, "2026-11-03T00:00:00.000Z", "2026-11-09T00:00:00.000Z"),
  r("Eggs", 4, "2026-11-04T00:00:00.000Z", "2026-11-01T00:00:00.000Z"),
];
const order = (id: Sort["id"], dir: Sort["dir"] = id === "az" ? "asc" : "desc") => [...list].sort(compareRecipes({ id, dir })).map((x) => x.title);

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
});
