import { describe, expect, it } from "vitest";
import { recipesToCache, recipesToKeep } from "../src/lib/offlineRecipes";

const T1 = "2026-11-10T10:00:00.000Z";
const T2 = "2026-11-11T10:00:00.000Z";

describe("recipesToCache", () => {
  it("fetches list recipes this device has not cached, once each", () => {
    expect(
      recipesToCache(
        ["a", "b", "a"],
        new Map([["b", T1]]),
        new Map([
          ["a", T1],
          ["b", T1],
        ]),
      ),
    ).toEqual(["a"]);
  });

  it("refetches a cached recipe the library list shows in a newer version", () => {
    expect(recipesToCache(["a"], new Map([["a", T1]]), new Map([["a", T2]]))).toEqual(["a"]);
    expect(recipesToCache(["a"], new Map([["a", T2]]), new Map([["a", T2]]))).toEqual([]);
  });

  it("skips recipes deleted from the library", () => {
    expect(recipesToCache(["gone"], new Map(), new Map([["a", T1]]))).toEqual([]);
  });

  it("fetches uncached ones before the library list has loaded", () => {
    expect(recipesToCache(["a", "b"], new Map([["b", T1]]), undefined)).toEqual(["a"]);
  });
});

describe("recipesToKeep", () => {
  const row = (id: string, ...users: ("alice" | "bob")[]) => ({ id, bookmarks: users.map((user) => ({ user, at: T1 })) });

  it("adds my bookmarks to the shopping list recipes, once each", () => {
    const list = [row("a", "alice"), row("b", "bob"), row("c", "alice", "bob"), row("d")];
    expect(recipesToKeep(["c", "x"], list, "alice")).toEqual(["c", "x", "a"]);
    expect(recipesToKeep([], list, "bob")).toEqual(["b", "c"]);
  });

  it("is just the shopping list until the library list has loaded", () => {
    expect(recipesToKeep(["x"], undefined, "alice")).toEqual(["x"]);
  });
});
