import { describe, expect, it } from "vitest";
import { searchRecipes } from "../shared/search";

const r = (title: string, ingredients: string[] = [], notes_md = "", tags: string[] = []) => ({ title, ingredients, notes_md, tags });
const list = [
  r("Bounty bars", ["Cottage cheese", "coconut"]),
  r("Cottage cheese Alfredo", ["cottage cheese", "fettuccine"]),
  r("Lasagne", ["ricotta"], "Works with cottage cheese instead of ricotta."),
  r("Dal", ["red lentils"], "", ["cuisine:indian", "course:main"]),
];
const titles = (q: string) => searchRecipes(list, q).map((x) => x.title);

describe("searchRecipes", () => {
  it("finds by ingredient and notes, case-insensitive, title matches first", () => {
    expect(titles("COTTAGE cheese")).toEqual(["Cottage cheese Alfredo", "Bounty bars", "Lasagne"]);
  });
  it("matches tag values, not group names, and needs every word", () => {
    expect(titles("indian")).toEqual(["Dal"]);
    expect(titles("cuisine")).toEqual([]);
    expect(titles("cottage lentils")).toEqual([]);
  });
  it("an empty query keeps the list and its order", () => {
    expect(titles("  ")).toEqual(list.map((x) => x.title));
  });
});
