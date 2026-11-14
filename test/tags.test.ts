import { describe, expect, it } from "vitest";
import { lintRecipe, withBoardTags } from "../shared/lint";
import { restoredContent } from "../shared/revisions";
import type { RecipeInput } from "../shared/schema";
import { onlyValidTags, overMax, renameLegacyTag, tagProblem, upgradeTag, upgradeTags } from "../shared/tags";
import { facetCounts, filterGroups, matchesTagFilter } from "../src/lib/tagFilter";

const recipe = (tags: string[], steps = "1. Mix."): RecipeInput => ({
  title: "Dal",
  sections: [{ ingredients: [{ item: "lentils", qty: 200, unit: "g" }] }],
  steps_md: steps,
  notes_md: "",
  tags,
});

describe("tagProblem", () => {
  it("accepts fixed values and kebab values in free groups", () => {
    for (const t of ["course:main", "cuisine:middle-eastern", "list:birthday", "collection:cottage-cheese-ideas", "todo:correction"])
      expect(tagProblem(t)).toBeNull();
  });
  it("rejects loose tags, unknown groups, unknown fixed values and non-kebab values", () => {
    expect(tagProblem("vegan")).toMatch(/has no group/);
    expect(tagProblem("ingredient:feta")).toMatch(/unknown group/);
    expect(tagProblem("course:pasta")).toMatch(/course is one of/);
    expect(tagProblem("list:next up")).toMatch(/lowercase words/);
    expect(tagProblem("list:-x")).toMatch(/lowercase words/);
  });
});

describe("legacy names", () => {
  it("map every kind of tag an old build wrote to a valid tag", () => {
    const old =
      "main oven side snack next-up dessert salad baking stub no-cook one-pot indian soup german italian breakfast birthday batch japanese basics sauce other needs-method middle-eastern korean instant-pot drink vegan mexican from-friends cambodian airfryer thai laotian".split(
        " ",
      );
    expect(old).toHaveLength(34);
    for (const t of old) expect(tagProblem(upgradeTag(t))).toBeNull();
  });
  it("rename fixed legacy names and turn any other loose kebab tag into a list", () => {
    expect(upgradeTags(["Needs-Method", "next-up", "birthday", "list:friends"])).toEqual(["todo:method", "list:next-up", "list:birthday", "list:friends"]);
  });
  it("typed input renames legacy names only, so an unknown word still needs a group", () => {
    expect(renameLegacyTag("vegan")).toBe("diet:vegan");
    expect(renameLegacyTag("birthday")).toBe("birthday");
  });
  it("upgrade keeps order and drops duplicates; onlyValidTags also drops loose leftovers", () => {
    expect(upgradeTags(["main", "course:main", "quick dinner"])).toEqual(["course:main", "quick dinner"]);
    expect(onlyValidTags(["main", "course:main", "quick dinner"])).toEqual(["course:main"]);
    expect(restoredContent(recipe(["vegan", "stub", "birthday", "x_y"])).tags).toEqual(["diet:vegan", "status:stub", "list:birthday"]);
  });
});

describe("lint and server tags", () => {
  it("lets the writer set content groups only, within limits", () => {
    expect(lintRecipe({ recipe: recipe(["course:main", "diet:vegan", "collection:x"]), review: [] })).toEqual([]);
    expect(lintRecipe({ recipe: recipe(["course:main", "list:next-up"]), review: [] })).toEqual([
      'tag "list:next-up": list tags are set by the server or the owners, not by the recipe writer',
    ]);
    expect(lintRecipe({ recipe: recipe(["course:main", "list:next-up"]), review: [] }, new Set(["list:next-up"]))).toEqual([]);
    expect(lintRecipe({ recipe: recipe(["cuisine:thai", "cuisine:korean"]), review: [] })).toEqual([
      "needs 1-2 course tags, has 0",
      "needs 0-1 cuisine tags, has 2",
    ]);
  });
  it("derives status:stub and todo:method", () => {
    expect(withBoardTags({ recipe: recipe(["course:main"], ""), review: [] })).toEqual(["course:main", "todo:method"]);
    expect(withBoardTags({ recipe: recipe(["course:main", "todo:method"]), review: [] })).toEqual(["course:main"]);
    expect(withBoardTags({ recipe: recipe(["course:main"], ""), review: ["stub"] })).toEqual(["course:main", "status:stub"]);
  });
  it("overMax names each group over its limit", () => {
    expect(overMax(["course:main", "course:side", "course:soup", "cuisine:thai"])).toEqual(["course allows at most 2"]);
  });
});

describe("list filter", () => {
  const lists = [["course:side", "course:main", "list:b"], ["course:main", "list:a", "list:b"], ["quick"]];
  it("groups tags in scheme order, fixed values in vocabulary order, free ones by use; loose tags left out", () => {
    expect(filterGroups(lists)).toEqual([
      {
        group: "course",
        tags: [
          { tag: "course:main", count: 2 },
          { tag: "course:side", count: 1 },
        ],
      },
      {
        group: "list",
        tags: [
          { tag: "list:b", count: 2 },
          { tag: "list:a", count: 1 },
        ],
      },
    ]);
  });
  it("ORs tags within a group and ANDs across groups", () => {
    expect(matchesTagFilter(["course:side"], new Set(["course:main", "course:side"]))).toBe(true);
    expect(matchesTagFilter(["course:side"], new Set(["course:side", "list:a"]))).toBe(false);
    expect(matchesTagFilter(["course:side", "list:a"], new Set(["course:side", "list:a"]))).toBe(true);
    expect(matchesTagFilter([], new Set())).toBe(true);
  });
});

describe("facetCounts", () => {
  const lists = [["course:main", "diet:vegan"], ["course:main"], ["course:side", "diet:vegan"], ["course:dessert", "diet:vegan"]];
  it("without a selection counts every use", () => {
    expect(facetCounts(lists, new Set()).get("diet:vegan")).toBe(3);
  });
  it("narrows other groups to the selection, keeps the own group as OR alternatives", () => {
    const c = facetCounts(lists, new Set(["course:main"]));
    expect(c.get("diet:vegan")).toBe(1);
    expect(c.get("course:side")).toBe(1);
    expect(c.get("course:main")).toBe(2);
  });
  it("a recipe failing two selected groups counts for nothing", () => {
    const c = facetCounts([["course:side"]], new Set(["course:main", "diet:vegan"]));
    expect(c.size).toBe(0);
  });
});
