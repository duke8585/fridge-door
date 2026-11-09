import { describe, expect, it } from "vitest";
import { addTag, normalizeTag, resolveTyped, splitTyped, tagCounts, tagKey, tagOptions, type TagKeyState, type TagOption } from "../src/lib/tagInput";

const counts = tagCounts([
  ["course:main", "cuisine:indian", "list:next-up"],
  ["course:main", "collection:cottage-cheese-ideas"],
  ["course:snack", "collection:cottage-cheese-ideas", "list:make-ahead"],
  ["course:main", "list:birthday"],
  ["quick"],
]);
const tags = (o: TagOption[]): string[] => o.map((x) => (x.kind === "new" ? `+${x.tag}` : x.tag));

describe("normalizeTag / addTag", () => {
  it("lowercases, trims, drops a leading #, tightens the colon and joins words with -", () => {
    expect(normalizeTag("  List: Next  Up ")).toBe("list:next-up");
    expect(normalizeTag("#Vegan")).toBe("vegan");
    expect(normalizeTag(" ## ")).toBe("");
  });
  it("adds a tag once and ignores empty input", () => {
    expect(addTag(["diet:vegan"], "diet:vegan")).toEqual(["diet:vegan"]);
    expect(addTag(["diet:vegan"], "")).toEqual(["diet:vegan"]);
    expect(addTag(["diet:vegan"], "course:main")).toEqual(["diet:vegan", "course:main"]);
  });
});

describe("tagOptions", () => {
  it("matches a bare word against the values of every group, prefix first", () => {
    expect(tags(tagOptions("cot", counts, []))).toEqual(["collection:cottage-cheese-ideas", "+list:cot", "+collection:cot"]);
    expect(tags(tagOptions("ma", counts, [])).slice(0, 2)).toEqual(["course:main", "list:make-ahead"]);
  });
  it("offers unused fixed values too, and no group choice for a word that is a known value", () => {
    expect(tags(tagOptions("vegan", counts, []))).toEqual(["diet:vegan"]);
    expect(tags(tagOptions("thai", counts, []))).toEqual(["cuisine:thai"]);
  });
  it("group: scopes to that group; a fixed group never offers a new value", () => {
    expect(tags(tagOptions("cuisine:", counts, []))[0]).toBe("cuisine:indian");
    expect(tags(tagOptions("cuisine:", counts, [])).every((t) => t.startsWith("cuisine:"))).toBe(true);
    expect(tags(tagOptions("cuisine:fren", counts, []))).toEqual([]);
    expect(tags(tagOptions("method:o", counts, []))).toEqual(["method:one-pot", "method:oven", "method:instant-pot", "method:no-cook"]);
  });
  it("a free group offers a new value, marked new, unless it exists or is invalid", () => {
    expect(tags(tagOptions("list:summer", counts, []))).toEqual(["+list:summer"]);
    expect(tags(tagOptions("list:next", counts, []))).toEqual(["list:next-up", "+list:next"]);
    expect(tags(tagOptions("list:next-up", counts, []))).toEqual(["list:next-up"]);
    expect(tags(tagOptions("list:", counts, []))).toEqual(["list:birthday", "list:make-ahead", "list:next-up"]);
    expect(tagOptions("nope:x", counts, [])).toEqual([]);
  });
  it("lists the most used valid tags for an empty query, without picked or loose ones", () => {
    expect(tags(tagOptions("", counts, ["course:main"]))).toEqual(["collection:cottage-cheese-ideas", "course:snack", "cuisine:indian", "list:birthday", "list:make-ahead", "list:next-up"]);
  });
  it("caps existing suggestions", () => {
    expect(tagOptions("e", counts, [], 3).filter((o) => o.kind === "existing")).toHaveLength(3);
  });
});

describe("resolveTyped", () => {
  it("takes a valid tag, a legacy name or the only tag with that value", () => {
    expect(resolveTyped("List: Summer", counts)).toBe("list:summer");
    expect(resolveTyped("needs-method", counts)).toBe("todo:method");
    expect(resolveTyped("indian", counts)).toBe("cuisine:indian");
  });
  it("needs a group for anything else", () => {
    expect(resolveTyped("cottage", counts)).toBeUndefined();
    expect(resolveTyped("course:pasta", counts)).toBeUndefined();
  });
});

describe("tagKey (keyboard behavior of the tag input)", () => {
  const options = tagOptions("cot", counts, []);
  const st = (patch: Partial<TagKeyState> = {}): TagKeyState => ({ text: "cot", options, active: 0, open: true, resolved: undefined, ...patch });

  it("arrows move the highlight and wrap", () => {
    expect(tagKey("ArrowDown", st())).toEqual({ type: "move", active: 1 });
    expect(tagKey("ArrowUp", st())).toEqual({ type: "move", active: options.length - 1 });
    expect(tagKey("ArrowDown", st({ active: options.length - 1 }))).toEqual({ type: "move", active: 0 });
    expect(tagKey("ArrowDown", st({ options: [] }))).toBeUndefined();
  });
  it("Enter, Tab and comma pick the highlighted option", () => {
    for (const key of ["Enter", "Tab", ","]) expect(tagKey(key, st())).toEqual({ type: "pick", tag: "collection:cottage-cheese-ideas" });
  });
  it("with nothing highlighted, picks what the text resolves to, else highlights a suggestion instead of adding a loose tag", () => {
    expect(tagKey("Enter", st({ open: false, text: "indian", resolved: "cuisine:indian" }))).toEqual({ type: "pick", tag: "cuisine:indian" });
    expect(tagKey("Enter", st({ open: false }))).toEqual({ type: "move", active: 0 });
    expect(tagKey("Enter", st({ open: false, options: [] }))).toEqual({ type: "close" });
  });
  it("leaves Enter and Tab alone on an empty input with nothing highlighted, and swallows a lone comma", () => {
    expect(tagKey("Enter", st({ text: "", active: -1 }))).toBeUndefined();
    expect(tagKey("Tab", st({ text: "", active: -1 }))).toBeUndefined();
    expect(tagKey(",", st({ text: "", active: -1 }))).toEqual({ type: "close" });
  });
  it("Backspace never removes a chip; Escape closes", () => {
    expect(tagKey("Backspace", st({ text: "" }))).toBeUndefined();
    expect(tagKey("Backspace", st())).toBeUndefined();
    expect(tagKey("Escape", st())).toEqual({ type: "close" });
    expect(tagKey("Escape", st({ open: false }))).toBeUndefined();
  });
});

describe("splitTyped (commas reaching the value: paste, Android keyboards)", () => {
  const indian: TagOption = { kind: "existing", tag: "cuisine:indian", count: 1 };
  it("keeps typing when there is no comma", () => {
    expect(splitTyped("ind", indian, counts)).toBeUndefined();
  });
  it("a single finished part takes the highlighted option", () => {
    expect(splitTyped("ind,", indian, counts)).toEqual({ picks: ["cuisine:indian"], text: "" });
  });
  it("a pasted list resolves each part; the first one needing a group stays as text", () => {
    expect(splitTyped("main, vegan, cottage, list:x,", undefined, counts)).toEqual({ picks: ["course:main", "diet:vegan", "list:x"], text: "cottage" });
    expect(splitTyped("main, oven, so", undefined, counts)).toEqual({ picks: ["course:main", "method:oven"], text: " so" });
  });
});
