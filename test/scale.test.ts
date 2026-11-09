import { describe, expect, it } from "vitest";
import { factorForYield, formatQty, roundQty, scaleIngredient, spoonInMl } from "../shared/scale";

describe("roundQty", () => {
  it.each([
    [[1.3, "piece"], { qty: 1.5, unit: "piece" }],
    [[0.2, "clove"], { qty: 0.5, unit: "clove" }],
    [[2.74, "clove"], { qty: 2.5, unit: "clove" }],
    [[0.6, "tsp"], { qty: 0.5, unit: "tsp" }],
    [[1.4, "tbsp"], { qty: 1.5, unit: "tbsp" }],
    [[3.3, "g"], { qty: 3.5, unit: "g" }],
    [[13.4, "g"], { qty: 13, unit: "g" }],
    [[66.7, "g"], { qty: 65, unit: "g" }],
    [[333.3, "g"], { qty: 330, unit: "g" }],
    [[562, "ml"], { qty: 550, unit: "ml" }],
    [[1250, "g"], { qty: 1.25, unit: "kg" }],
    [[0.3, "l"], { qty: 300, unit: "ml" }],
    [[2.66, "kg"], { qty: 2.7, unit: "kg" }],
  ] as const)("%j", ([q, u], want) => expect(roundQty(q, u)).toEqual(want));
});

describe("scaleIngredient", () => {
  it("never scales items without qty", () => {
    const salt = { item: "salt", note: "to taste" };
    expect(scaleIngredient(salt, 3)).toBe(salt);
  });
  it("scales ranges and keeps them in one unit", () => {
    expect(scaleIngredient({ item: "garlic", qty: 4, qtyMax: 6, unit: "clove" }, 1.5)).toEqual({ item: "garlic", qty: 6, qtyMax: 9, unit: "clove" });
    expect(scaleIngredient({ item: "flour", qty: 600, qtyMax: 800, unit: "g" }, 2)).toEqual({ item: "flour", qty: 1.2, qtyMax: 1.6, unit: "kg" });
  });
  it("promotes units consistently at every factor, including x1", () => {
    const flour = { item: "flour", qty: 1250, unit: "g" as const };
    expect(scaleIngredient(flour, 1)).toEqual({ item: "flour", qty: 1.25, unit: "kg" });
    expect(scaleIngredient(flour, 2)).toEqual({ item: "flour", qty: 2.5, unit: "kg" });
    expect(scaleIngredient(flour, 0.5)).toEqual({ item: "flour", qty: 625, unit: "g" });
    expect(formatQty(1.25, undefined, "kg")).toBe("1.25 kg");
  });
  it("keeps x1 amounts exact (no rounding), only the unit changes", () => {
    expect(scaleIngredient({ item: "sugar", qty: 333, unit: "g" }, 1)).toEqual({ item: "sugar", qty: 333, unit: "g" });
    expect(scaleIngredient({ item: "milk", qty: 0.25, unit: "l" }, 1)).toEqual({ item: "milk", qty: 250, unit: "ml" });
    const x1 = scaleIngredient({ item: "flour", qty: 1234, unit: "g" }, 1);
    expect(formatQty(x1.qty, x1.qtyMax, x1.unit)).toBe("1.234 kg");
  });
  it("keeps a range whose max crosses the kg threshold", () => {
    expect(scaleIngredient({ item: "potatoes", qty: 800, qtyMax: 1200, unit: "g" }, 1)).toEqual({ item: "potatoes", qty: 800, qtyMax: 1200, unit: "g" });
    expect(scaleIngredient({ item: "potatoes", qty: 800, qtyMax: 1200, unit: "g" }, 1.1)).toEqual({ item: "potatoes", qty: 875, qtyMax: 1325, unit: "g" });
  });
  it("re-promotes when rounding crosses 1000 g", () => {
    expect(roundQty(995, "g")).toEqual({ qty: 1, unit: "kg" });
  });
  it("halves 2 servings of 200 g spaghetti to 100 g", () => {
    expect(scaleIngredient({ item: "spaghetti", qty: 200, unit: "g" }, factorForYield(2, 1))).toEqual({ item: "spaghetti", qty: 100, unit: "g" });
  });
});

describe("format", () => {
  it("formats spoons with fractions and pluralizes cloves", () => {
    expect(formatQty(1.5, undefined, "tbsp")).toBe("1½ tbsp");
    expect(formatQty(0.5, 1, "tsp")).toBe("½-1 tsp");
    expect(formatQty(4, 6, "clove")).toBe("4-6 cloves");
    expect(formatQty(2, undefined, "piece")).toBe("2");
    expect(formatQty(undefined, undefined, undefined)).toBe("");
  });
  it("shows ml for spoons only", () => {
    expect(spoonInMl(2, undefined, "tbsp")).toBe("30 ml");
    expect(spoonInMl(0.5, 1, "tsp")).toBe("2.5-5 ml");
    expect(spoonInMl(100, undefined, "g")).toBeUndefined();
  });
});
