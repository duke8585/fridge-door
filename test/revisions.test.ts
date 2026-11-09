import { describe, expect, it } from "vitest";
import type { RecipeInput } from "../shared/schema";
import { diffLines, diffRecipes, summarizeDiff } from "../shared/revisions";

const base: RecipeInput = {
  title: "Dal",
  yield: { amount: 4, unit: "servings" },
  sections: [
    {
      ingredients: [
        { item: "red lentils", qty: 200, unit: "g" },
        { item: "salt", note: "to taste" },
        { item: "garlic", qty: 2, unit: "clove" },
      ],
    },
  ],
  steps_md: "1. Rinse.\n2. Simmer.\n3. Serve.",
  notes_md: "",
  tags: ["course:main", "list:quick"],
};

describe("diffLines", () => {
  it("keeps common lines and marks the rest added or removed, in order", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "x" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
  });
  it("handles empty sides", () => {
    expect(diffLines("", "a")).toEqual([
      { op: "del", text: "" },
      { op: "add", text: "a" },
    ]);
    expect(diffLines("a", "a")).toEqual([{ op: "same", text: "a" }]);
  });
});

describe("diffRecipes", () => {
  it("is empty for identical content", () => {
    const d = diffRecipes(base, structuredClone(base));
    expect(summarizeDiff(d)).toEqual([]);
    expect(d.steps).toBeUndefined();
  });

  it("reports title, yield, time, tags and section titles as from/to", () => {
    const d = diffRecipes(base, {
      ...base,
      title: "Dal tadka",
      yield: undefined,
      time: { total_min: 45, active_min: 20 },
      tags: ["course:main", "diet:vegan"],
      sections: [{ title: "Dal", ingredients: base.sections[0]!.ingredients }],
    });
    expect(d.title).toEqual({ from: "Dal", to: "Dal tadka" });
    expect(d.yield).toEqual({ from: "4 servings", to: "" });
    expect(d.time).toEqual({ from: "", to: "45 min (20 active)" });
    expect(d.tags).toEqual({ added: ["diet:vegan"], removed: ["list:quick"] });
    expect(d.sections).toEqual({ from: "", to: "Dal" });
    expect(d.ingredients).toEqual({ added: [], removed: [], changed: [] });
  });

  it("pairs ingredients by item: same line unchanged, same item changed, the rest added/removed", () => {
    const d = diffRecipes(base, {
      ...base,
      sections: [
        { ingredients: [{ item: "garlic", qty: 2, unit: "clove" }] },
        { title: "Tadka", ingredients: [{ item: "Red lentils", qty: 250, unit: "g", prep: "rinsed" }, { item: "cumin", qty: 1, unit: "tsp" }] },
      ],
    });
    expect(d.ingredients).toEqual({
      added: ["1 tsp cumin"],
      removed: ["salt (to taste)"],
      changed: [{ from: "200 g red lentils", to: "250 g Red lentils, rinsed" }],
    });
    expect(summarizeDiff(d)).toEqual(["sections", "ingredients +1 -1 ~1"]);
  });

  it("does not mispair duplicates when one of them is unchanged", () => {
    const two = (a: number, b: number): RecipeInput => ({
      ...base,
      sections: [{ ingredients: [{ item: "salt", qty: a, unit: "tsp" }, { item: "salt", qty: b, unit: "tsp" }] }],
    });
    expect(diffRecipes(two(1, 2), two(2, 3)).ingredients).toEqual({ added: [], removed: [], changed: [{ from: "1 tsp salt", to: "3 tsp salt" }] });
  });

  it("line-diffs steps and notes and summarizes them by name", () => {
    const d = diffRecipes(base, { ...base, steps_md: "1. Rinse.\n2. Simmer 20 min.\n3. Serve.", notes_md: "Freezes well." });
    expect(d.steps?.filter((l) => l.op !== "same")).toEqual([
      { op: "del", text: "2. Simmer." },
      { op: "add", text: "2. Simmer 20 min." },
    ]);
    expect(summarizeDiff(d)).toEqual(["steps", "notes"]);
  });
});
