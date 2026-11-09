import { describe, expect, it } from "vitest";
import { parseFactor, readScale, writeScale } from "../src/lib/scaleParams";

describe("parseFactor (custom factor input)", () => {
  it.each([
    ["2", 2],
    ["0,75", 0.75],
    ["0.75", 0.75],
    ["3/4", 0.75],
    ["1 1/2", 1.5],
    ["½", 0.5],
    ["1½", 1.5],
    ["x2", 2],
    [" 1.5 ", 1.5],
  ])("%j -> %s", (raw, want) => expect(parseFactor(raw)).toBe(want));
  it.each(["", "0", "0,0", "-1", "abc", "1/0", "1.", ".", "999"])("%j is invalid", (raw) => expect(parseFactor(raw)).toBeUndefined());
});

describe("scale state in the URL", () => {
  it("reads servings for recipes with a yield and ignores factor", () => {
    expect(readScale("?servings=6&factor=3", 4)).toEqual({ servings: 6, factor: 1 });
    expect(readScale("", 4)).toEqual({ servings: 4, factor: 1 });
    expect(readScale("?servings=0", 4)).toEqual({ servings: 4, factor: 1 });
    expect(readScale("?servings=abc", 4)).toEqual({ servings: 4, factor: 1 });
  });
  it("reads factor for recipes without a yield", () => {
    expect(readScale("?factor=1.5", undefined)).toEqual({ servings: 1, factor: 1.5 });
    expect(readScale("?factor=-2", undefined)).toEqual({ servings: 1, factor: 1 });
  });
  it("writes only non-default params and keeps others", () => {
    expect(writeScale("", { servings: 6, factor: 1 }, 4)).toBe("?servings=6");
    expect(writeScale("?servings=6", { servings: 4, factor: 1 }, 4)).toBe("");
    expect(writeScale("?x=1", { servings: 1, factor: 0.5 }, undefined)).toBe("?x=1&factor=0.5");
    expect(writeScale("?factor=2", { servings: 1, factor: 1 }, undefined)).toBe("");
  });
  it("round-trips", () => {
    const s = { servings: 1, factor: 0.75 };
    expect(readScale(writeScale("", s, undefined), undefined)).toEqual(s);
  });
});
