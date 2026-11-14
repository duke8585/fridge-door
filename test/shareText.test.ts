import { describe, expect, it } from "vitest";
import type { Recipe } from "../shared/schema";
import { plainText, recipeToText } from "../src/lib/shareText";

const recipe = {
  id: "r1",
  title: "Dal",
  yield: { amount: 2, unit: "servings" },
  time: null,
  sections: [{ title: "Base", ingredients: [{ item: "red lentils", qty: 200, unit: "g" }] }, { ingredients: [{ item: "salt" }] }],
  steps_md: "1. Rinse the **lentils**.\n2. Simmer, see [video](https://example.com/v).",
  notes_md: "## Tip\nUse *ghee*.",
  tags: ["course:main"],
  source_url: "https://example.com/dal",
} as unknown as Recipe;

describe("recipeToText", () => {
  it("is plain text at the given scale, with steps, notes and source, without tags", () => {
    expect(recipeToText(recipe, 2, "https://fd.example/recipes/r1")).toBe(
      [
        "Dal",
        "4 servings",
        "",
        "Ingredients",
        "",
        "Base:",
        "- 400 g red lentils",
        "- salt",
        "",
        "Steps",
        "1. Rinse the lentils.",
        "2. Simmer, see video (https://example.com/v).",
        "",
        "Notes",
        "Tip:",
        "Use ghee.",
        "",
        "Source: https://example.com/dal",
        "",
        "<!-- from Fridge Door: https://fd.example/recipes/r1 -->",
      ].join("\n"),
    );
  });
});

describe("plainText", () => {
  it("keeps snake_case words and lone asterisks", () => {
    expect(plainText("use a_b_c and 2 * 3")).toBe("use a_b_c and 2 * 3");
  });
  it("collapses a link whose text is its url", () => {
    expect(plainText("[https://x.y](https://x.y)")).toBe("https://x.y");
  });
});
