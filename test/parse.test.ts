import { describe, expect, it } from "vitest";
import { parseIngredientBlock, parseIngredientLine, parseNumber } from "../shared/parse";

describe("parseNumber", () => {
  it.each([
    ["1", 1],
    ["1.5", 1.5],
    ["1,5", 1.5],
    ["1/2", 0.5],
    ["1 1/2", 1.5],
    ["½", 0.5],
    ["1½", 1.5],
    ["abc", undefined],
    ["", undefined],
  ])("%s -> %s", (raw, want) => expect(parseNumber(raw)).toBe(want));
});

describe("parseIngredientLine", () => {
  it.each([
    ["200 g flour, sifted", { item: "flour", qty: 200, unit: "g", prep: "sifted" }],
    ["200g flour", { item: "flour", qty: 200, unit: "g" }],
    ["2-3 cloves garlic, minced", { item: "garlic", qty: 2, qtyMax: 3, unit: "clove", prep: "minced" }],
    ["1 1/2 tbsp olive oil", { item: "olive oil", qty: 1.5, unit: "tbsp" }],
    ["½ tsp salt", { item: "salt", qty: 0.5, unit: "tsp" }],
    ["3 eggs", { item: "eggs", qty: 3, unit: "piece" }],
    ["2 tomatoes", { item: "tomatoes", qty: 2, unit: "piece" }],
    ["1 l milk", { item: "milk", qty: 1, unit: "l" }],
    ["500 ml of stock", { item: "stock", qty: 500, unit: "ml" }],
    ["salt (to taste)", { item: "salt", note: "to taste" }],
    ["salt to taste", { item: "salt", note: "to taste" }],
    ["a pinch of nutmeg", { item: "nutmeg", note: "a pinch" }],
    ["- 100 g butter, cold (or margarine)", { item: "butter", qty: 100, unit: "g", prep: "cold", note: "or margarine" }],
    ["parsley", { item: "parsley" }],
  ])("%s", (line, want) => expect(parseIngredientLine(line)).toEqual(want));

  it("ignores blank lines", () => expect(parseIngredientLine("   ")).toBeUndefined());
});

describe("parseIngredientBlock", () => {
  it("splits lines and sections", () => {
    const out = parseIngredientBlock("200 g flour\n2 eggs\n\nFor the sauce:\n100 ml cream\nsalt to taste\n");
    expect(out).toEqual([
      {
        ingredients: [
          { item: "flour", qty: 200, unit: "g" },
          { item: "eggs", qty: 2, unit: "piece" },
        ],
      },
      {
        title: "For the sauce",
        ingredients: [
          { item: "cream", qty: 100, unit: "ml" },
          { item: "salt", note: "to taste" },
        ],
      },
    ]);
  });
  it("uses a leading header as the first section title", () => {
    expect(parseIngredientBlock("For the cake:\n225 g butter")[0]).toEqual({ title: "For the cake", ingredients: [{ item: "butter", qty: 225, unit: "g" }] });
  });
});
