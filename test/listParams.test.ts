import { describe, expect, it } from "vitest";
import { readFilter, writeFilter } from "../src/lib/listParams";
import { DEFAULT_SORT } from "../src/lib/recipeSort";

describe("list filter in the URL", () => {
  it("round-trips search, tags, time and sort", () => {
    const f = { q: "pasta al forno", tags: new Set(["course:main", "diet:vegetarian"]), time: "30", sort: { id: "rating", dir: "asc" } as const };
    const back = readFilter(writeFilter("", f));
    expect(back).toEqual(f);
  });
  it("writes nothing for the defaults", () => {
    expect(writeFilter("", { q: "", tags: new Set(), time: null, sort: DEFAULT_SORT })).toBe("");
  });
  it("keeps other params and replaces its own", () => {
    expect(writeFilter("?x=1&q=old&tag=a:b", { q: "", tags: new Set(["course:main"]), time: null, sort: DEFAULT_SORT })).toBe("?x=1&tag=course%3Amain");
  });
  it("falls back to defaults for unknown values", () => {
    expect(readFilter("?time=5&sort=nope&dir=up")).toEqual({ q: "", tags: new Set(), time: null, sort: DEFAULT_SORT });
    expect(readFilter("?sort=az").sort).toEqual({ id: "az", dir: "asc" });
  });
});
