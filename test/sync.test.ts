import { describe, expect, it } from "vitest";
import type { RecipeDetail, RecipeSummary, ShoppingItem } from "../shared/schema";
import { groupShopping, ingredientsToShopping, mergeRemote, nextTimestamp, recipeScaleLabel, scaleLabel } from "../shared/shopping";
import { applyTagDelta } from "../shared/tags";
import { applyOp, applyOpToSummary, type OutboxOp } from "../src/store/ops";

const item = (id: string, patch: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id,
  item: "butter",
  checked: false,
  updated_at: "2026-11-08T10:00:00.000Z",
  ...patch,
});

describe("mergeRemote (LWW per item)", () => {
  it("adds unknown remote items", () => {
    const local = new Map<string, ShoppingItem>();
    expect(mergeRemote(local, [item("a")])).toEqual(["a"]);
    expect(local.get("a")?.item).toBe("butter");
  });
  it("newer remote wins", () => {
    const local = new Map([["a", item("a")]]);
    mergeRemote(local, [item("a", { checked: true, updated_at: "2026-11-08T10:00:05.000Z" })]);
    expect(local.get("a")?.checked).toBe(true);
  });
  it("older remote loses against a newer local (offline) edit", () => {
    const local = new Map([["a", item("a", { checked: true, updated_at: "2026-11-08T10:00:09.000Z" })]]);
    expect(mergeRemote(local, [item("a", { checked: false, updated_at: "2026-11-08T10:00:05.000Z" })])).toEqual([]);
    expect(local.get("a")?.checked).toBe(true);
  });
  it("tie goes to remote (server already decided) and is not reported as a change when identical", () => {
    const local = new Map([["a", item("a")]]);
    expect(mergeRemote(local, [item("a")])).toEqual([]);
  });
  it("propagates tombstones", () => {
    const local = new Map([["a", item("a")]]);
    mergeRemote(local, [item("a", { deleted: true, updated_at: "2026-11-08T11:00:00.000Z" })]);
    expect(groupShopping(local.values())).toEqual([]);
  });
  it("two devices converge regardless of arrival order", () => {
    const a = item("x", { checked: true, updated_at: "2026-11-08T10:00:01.000Z" });
    const b = item("x", { checked: false, updated_at: "2026-11-08T10:00:02.000Z" });
    const d1 = new Map<string, ShoppingItem>();
    const d2 = new Map<string, ShoppingItem>();
    mergeRemote(d1, [a]);
    mergeRemote(d1, [b]);
    mergeRemote(d2, [b]);
    mergeRemote(d2, [a]);
    expect(d1.get("x")).toEqual(d2.get("x"));
    expect(d1.get("x")?.checked).toBe(false);
  });
});

describe("nextTimestamp", () => {
  it("is monotonic even if the clock goes backwards", () => {
    const prev = "2026-11-08T10:00:00.000Z";
    expect(nextTimestamp(prev, new Date("2026-11-08T09:00:00.000Z"))).toBe("2026-11-08T10:00:00.001Z");
  });
});

describe("groupShopping", () => {
  it("groups by base, alphabetical whether ticked or not", () => {
    const groups = groupShopping([
      item("1", { item: "Butter", qty: 100, unit: "g", recipe_title: "Pancakes" }),
      item("2", { item: "butter ", qty: 200, unit: "g", recipe_title: "Cake" }),
      item("3", { item: "apples", checked: true }),
    ]);
    expect(groups.map((g) => [g.key, g.lines.map((l) => l.recipe_title), g.allChecked])).toEqual([
      ["apple", [undefined], true],
      ["butter", ["Cake", "Pancakes"], false],
    ]);
  });
  it("tags each row with the recipe's scale, and leaves it out at 1", () => {
    const at = "2026-11-08T10:00:00.000Z";
    const ing = [{ item: "flour", qty: 400, unit: "g" as const }];
    expect(ingredientsToShopping(ing, { id: "r", title: "R", scale: 2 }, () => "id", at)[0]!.scale).toBe(2);
    expect(ingredientsToShopping(ing, { id: "r", title: "R", scale: 1 }, () => "id", at)[0]).not.toHaveProperty("scale");
    expect(ingredientsToShopping(ing, { id: "r", title: "R" }, () => "id", at)[0]).not.toHaveProperty("scale");
  });
  it("labels scales as chips: none when unscaled, every scale when a recipe was added at several", () => {
    expect(scaleLabel(undefined)).toBeNull();
    expect(scaleLabel(1)).toBeNull();
    expect(scaleLabel(1.5)).toBe("×1½");
    expect(recipeScaleLabel(new Set([1]))).toBeNull();
    expect(recipeScaleLabel(new Set([2, 1]))).toBe("×1 ×2");
  });
  it("adds unscalable ingredients without qty", () => {
    const rows = ingredientsToShopping([{ item: "salt", note: "to taste" }], { id: "r", title: "R" }, () => "id", "2026-11-08T10:00:00.000Z");
    expect(rows[0]).toMatchObject({ item: "salt", qty: undefined, recipe_id: "r", recipe_title: "R" });
  });
});

describe("applyOp (optimistic recipe ops)", () => {
  const detail: RecipeDetail = {
    recipe: {
      id: "r",
      title: "R",
      sections: [],
      steps_md: "",
      notes_md: "",
      tags: ["a"],
      ratings: [{ user: "bob", stars: 3 }],
      bookmarks: [],
      created_at: "",
      updated_at: "",
      cover_focus: null,
    },
    comments: [],
  };
  it("is idempotent for rating replays", () => {
    const op = { kind: "rating", recipe_id: "r", user: "alice", stars: 5 } as const;
    expect(applyOp(applyOp(detail, op), op).recipe.ratings).toEqual([
      { user: "alice", stars: 5 },
      { user: "bob", stars: 3 },
    ]);
  });
  it("sets and resets the cover focus", () => {
    const set = applyOp(detail, { kind: "cover.focus", recipe_id: "r", user: "alice", focus: { x: 20, y: 80 } });
    expect(set.recipe.cover_focus).toEqual({ x: 20, y: 80 });
    expect(applyOp(set, { kind: "cover.focus", recipe_id: "r", user: "alice", focus: null }).recipe.cover_focus).toBeNull();
  });
  it("ignores ops for other recipes", () => {
    expect(applyOp(detail, { kind: "tags.delta", recipe_id: "other", user: "alice", add: ["x"], remove: [] })).toBe(detail);
  });
});

describe("tag deltas", () => {
  const add = (tag: string) => ({ add: [tag], remove: [] });
  const remove = (tag: string) => ({ add: [], remove: [tag] });
  it("add of an existing tag and remove of a missing tag are no-ops", () => {
    expect(applyTagDelta(["a", "b"], add("a"))).toEqual(["a", "b"]);
    expect(applyTagDelta(["a", "b"], remove("zzz"))).toEqual(["a", "b"]);
    expect(applyTagDelta(["a"], add(" List:Quick "))).toEqual(["a", "list:quick"]);
  });
  it("replays are idempotent", () => {
    const once = applyTagDelta(["a"], { add: ["b"], remove: ["a"] });
    expect(applyTagDelta(once, { add: ["b"], remove: ["a"] })).toEqual(once);
  });
  it("concurrent offline add + online add keep both", () => {
    // Device A is offline and queues "+diet:vegan". Meanwhile device B (online) adds "list:quick".
    const server0 = ["course:main"];
    const offlineOp: OutboxOp = { kind: "tags.delta", recipe_id: "r", user: "alice", add: ["diet:vegan"], remove: [] };
    const server1 = applyTagDelta(server0, add("list:quick")); // B's PATCH lands first
    // A revalidates while its op is still pending: the fresh server copy plus the pending op shows both.
    const fresh: RecipeDetail = {
      recipe: {
        id: "r",
        title: "R",
        sections: [],
        steps_md: "",
        notes_md: "",
        tags: server1,
        ratings: [],
        bookmarks: [],
        created_at: "",
        updated_at: "",
        cover_focus: null,
      },
      comments: [],
    };
    expect(applyOp(fresh, offlineOp).recipe.tags).toEqual(["course:main", "list:quick", "diet:vegan"]);
    // A comes back online and its op replays on the server: both survive.
    expect(applyTagDelta(server1, { add: ["diet:vegan"], remove: [] })).toEqual(["course:main", "list:quick", "diet:vegan"]);
  });
  it("concurrent remove + add of different tags keep both changes", () => {
    const afterB = applyTagDelta(["course:main", "list:quick"], remove("list:quick"));
    expect(applyTagDelta(afterB, add("diet:vegan"))).toEqual(["course:main", "diet:vegan"]);
  });
});

describe("ops queued by a build from before the tag groups", () => {
  it("apply with the current names, so a cached recipe never shows a loose tag", () => {
    const d: RecipeDetail = {
      recipe: {
        id: "r",
        title: "R",
        sections: [],
        steps_md: "",
        notes_md: "",
        tags: ["course:main", "list:next-up"],
        ratings: [],
        bookmarks: [],
        created_at: "",
        updated_at: "",
        cover_focus: null,
      },
      comments: [],
    };
    const old: OutboxOp = { kind: "tags.delta", recipe_id: "r", user: "alice", add: ["vegan"], remove: ["next-up"] };
    expect(applyOp(d, old).recipe.tags).toEqual(["course:main", "diet:vegan"]);
  });
});

describe("applyOpToSummary (library list follows local edits)", () => {
  const s: RecipeSummary = {
    id: "r",
    title: "R",
    tags: ["course:main"],
    ingredients: [],
    notes_md: "",
    cover_focus: null,
    avg_rating: null,
    rating_count: 0,
    bookmarks: [],
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
  };
  it("a tag or crop edit moves updated_at to the edit time, never backwards", () => {
    const at = "2026-11-09T10:00:00.000Z";
    const tagged = applyOpToSummary(s, { kind: "tags.delta", recipe_id: "r", user: "alice", add: ["diet:vegan"], remove: [], at });
    expect(tagged).toMatchObject({ tags: ["course:main", "diet:vegan"], updated_at: at });
    expect(applyOpToSummary(s, { kind: "cover.focus", recipe_id: "r", user: "alice", focus: null, at: "2026-01-01T00:00:00.000Z" }).updated_at).toBe(
      s.updated_at,
    );
    expect(applyOpToSummary(s, { kind: "tags.delta", recipe_id: "r", user: "alice", add: ["x"], remove: [] }).updated_at).toBe(s.updated_at);
  });
  it("leaves other recipes and other ops alone", () => {
    expect(applyOpToSummary(s, { kind: "tags.delta", recipe_id: "other", user: "alice", add: ["diet:vegan"], remove: [] })).toBe(s);
    expect(applyOpToSummary(s, { kind: "rating", recipe_id: "r", user: "alice", stars: 5 })).toBe(s);
  });
});

describe("bookmark ops", () => {
  const T = "2026-11-09T10:00:00.000Z";
  const updated = "2026-11-05T00:00:00.000Z";
  const on = { kind: "bookmark", recipe_id: "r", user: "alice", on: true, at: T } as const;
  const off = { ...on, on: false } as const;
  const detail: RecipeDetail = {
    recipe: {
      id: "r",
      title: "R",
      sections: [],
      steps_md: "",
      notes_md: "",
      tags: [],
      ratings: [],
      bookmarks: [{ user: "bob", at: "2026-11-01T00:00:00.000Z" }],
      created_at: "",
      updated_at: updated,
      cover_focus: null,
    },
    comments: [],
  };
  const summary: RecipeSummary = {
    id: "r",
    title: "R",
    tags: [],
    ingredients: [],
    notes_md: "",
    cover_focus: null,
    avg_rating: null,
    rating_count: 0,
    bookmarks: [],
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: updated,
  };

  it("adds and removes only the user's entry, without moving updated_at", () => {
    const saved = applyOp(detail, on);
    expect(saved.recipe.bookmarks).toEqual([
      { user: "alice", at: T },
      { user: "bob", at: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(saved.recipe.updated_at).toBe(updated);
    const removed = applyOp(saved, off);
    expect(removed.recipe.bookmarks).toEqual(detail.recipe.bookmarks);
    expect(removed.recipe.updated_at).toBe(updated);
  });
  it("replays are idempotent and keep the first time", () => {
    const once = applyOp(detail, on);
    expect(applyOp(once, { ...on, at: "2026-11-10T00:00:00.000Z" })).toEqual(once);
    expect(applyOp(applyOp(detail, off), off)).toEqual(applyOp(detail, off));
  });
  it("patches the library row the same way", () => {
    const row = applyOpToSummary(summary, on);
    expect(row).toEqual({ ...summary, bookmarks: [{ user: "alice", at: T }] });
    expect(applyOpToSummary(row, off)).toEqual(summary);
  });
});
