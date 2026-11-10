import { describe, expect, it } from "vitest";
import { buildCatalogue, completeAisleOrder, DEFAULT_AISLE_ORDER, resolveLocal, ruleBase, singularKey, storedName } from "../shared/catalogue";
import type { ShoppingItem } from "../shared/schema";
import { searchRecipes } from "../shared/search";
import { byAisle, groupShopping, ingredientsToShopping, mergeRemote } from "../shared/shopping";

const cat = buildCatalogue({
  bases: [
    { base: "apple", aisle: "produce", origin: "seed" },
    { base: "brown sugar", aisle: "baking", origin: "seed" },
    { base: "sugar", aisle: "baking", origin: "seed" },
    { base: "aubergine", aisle: "produce", origin: "seed" },
    { base: "red lentil", aisle: "grains", origin: "seed" },
    { base: "black pepper", aisle: "spices", origin: "seed" },
  ],
  aliases: [
    { alias: "red apple", base: "apple", origin: "seed" },
    { alias: "dark brown sugar", base: "brown sugar", origin: "seed" },
    { alias: "eggplant", base: "aubergine", origin: "seed" },
    { alias: "pepper", base: "black pepper", origin: "seed" },
  ],
});

describe("resolveLocal", () => {
  it("matches an alias exactly first", () => {
    expect(resolveLocal(cat, "Eggplant")).toEqual({ base: "aubergine", aisle: "produce", how: "alias" });
  });
  it("then singularizes and drops descriptors, trying the longer name before the shorter", () => {
    expect(resolveLocal(cat, "Red Apples")).toMatchObject({ base: "apple", how: "rule" });
    expect(resolveLocal(cat, "finely chopped apples, peeled")).toMatchObject({ base: "apple", how: "rule" });
    expect(resolveLocal(cat, "dark brown sugar")).toMatchObject({ base: "brown sugar" });
    expect(resolveLocal(cat, "red lentils (washed)")).toMatchObject({ base: "red lentil", aisle: "grains" });
    expect(resolveLocal(cat, "freshly ground black pepper")).toMatchObject({ base: "freshly ground black pepper", how: "unknown" });
  });
  it("keeps the rule result with aisle other when nothing matches", () => {
    expect(resolveLocal(cat, "Fresh Curry Leaves")).toEqual({ base: "fresh curry leaf", aisle: "other", how: "unknown" });
    expect(resolveLocal(cat, "Granny Smith apples")).toMatchObject({ how: "unknown", base: "granny smith apple" });
  });
});

describe("the rules", () => {
  it("singularize the last word only, with the usual English endings", () => {
    expect(["tomatoes", "berries", "peaches", "bay leaves", "olives", "oats", "couscous", "asparagus", "hummus", "glass"].map(singularKey)).toEqual([
      "tomato",
      "berry",
      "peach",
      "bay leaf",
      "olive",
      "oats",
      "couscous",
      "asparagus",
      "hummus",
      "glass",
    ]);
  });
  it("strip notes, alternatives, accents and descriptors", () => {
    expect(ruleBase("Butter or margarine")).toBe("butter");
    expect(ruleBase("Crème fraîche")).toBe("creme fraiche");
    expect(ruleBase("large organic eggs")).toBe("organic egg");
    expect(ruleBase("red")).toBe("red");
    expect(storedName("Granny Smith Apples")).toBe("granny smith apple");
  });
});

describe("aisle order", () => {
  it("is completed: unknown and repeated ids dropped, missing aisles appended in default order", () => {
    const order = completeAisleOrder(["dairy", "nope", "dairy", "produce"]);
    expect(order.slice(0, 2)).toEqual(["dairy", "produce"]);
    expect([...order].sort()).toEqual([...DEFAULT_AISLE_ORDER].sort());
  });
});

const row = (id: string, item: string, extra: Partial<ShoppingItem> = {}): ShoppingItem => ({ id, item, checked: false, updated_at: "2026-11-09T10:00:00.000Z", ...extra });

describe("shopping list by base and aisle", () => {
  it("groups red apple and apples into one group and sorts groups by the household aisle order", () => {
    const groups = groupShopping(
      [
        row("1", "red apple", { base: "apple", aisle: "produce", recipe_title: "Crumble" }),
        row("2", "apples"),
        row("3", "red lentils", { base: "red lentil", aisle: "grains" }),
        row("4", "kitchen magic"),
      ],
      cat,
    );
    expect(groups.find((g) => g.key === "apple")?.lines.map((l) => l.id).sort()).toEqual(["1", "2"]);
    const sections = byAisle(groups, ["grains", "produce"]);
    expect(sections.map((s) => [s.aisle, s.groups.map((g) => g.key)])).toEqual([
      ["grains", ["red lentil"]],
      ["produce", ["apple"]],
      ["other", ["kitchen magic"]],
    ]);
  });
  it("takes a group's aisle from its most recent line, so a move shows before every line synced", () => {
    const [g] = groupShopping([
      row("1", "apple", { base: "apple", aisle: "produce" }),
      row("2", "apple", { base: "apple", aisle: "sweets-snacks", updated_at: "2026-11-09T11:00:00.000Z" }),
    ]);
    expect(g!.aisle).toBe("sweets-snacks");
  });
  it("rows from a recipe carry the ingredient's base and the catalogue's aisle", () => {
    const rows = ingredientsToShopping([{ item: "red lentils", qty: 200, unit: "g", base: "red lentil" }, { item: "salt", note: "to taste" }], { id: "r", title: "R" }, () => "id", "t", cat);
    expect(rows.map((r) => [r.base, r.aisle])).toEqual([
      ["red lentil", "grains"],
      [undefined, undefined],
    ]);
  });
  it("a server copy that only adds base and aisle still counts as a change, so it is persisted", () => {
    const local = new Map([["1", row("1", "apples")]]);
    expect(mergeRemote(local, [row("1", "apples", { base: "apple", aisle: "produce" })])).toEqual(["1"]);
  });
});

describe("recipe search via bases", () => {
  const list = [
    { title: "Crumble", tags: [], ingredients: ["red apple"], bases: ["apple"], notes_md: "" },
    { title: "Parmigiana", tags: [], ingredients: ["eggplant"], bases: ["aubergine"], notes_md: "" },
    { title: "Old cache", tags: [], ingredients: ["pear"], notes_md: "" },
  ];
  it('"apples" finds a recipe with "red apple", and an alias finds its base', () => {
    expect(searchRecipes(list, "apples", cat).map((r) => r.title)).toEqual(["Crumble"]);
    expect(searchRecipes(list, "aubergines", cat).map((r) => r.title)).toEqual(["Parmigiana"]);
    expect(searchRecipes(list, "pears").map((r) => r.title)).toEqual([]);
    expect(searchRecipes(list, "pear").map((r) => r.title)).toEqual(["Old cache"]);
  });
});
