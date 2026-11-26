import { describe, expect, it } from "vitest";
import { coverPrompt, MAX_PROMPT, titleInitials } from "../shared/coverArt";
import type { RecipeInput } from "../shared/schema";
import { primaryCourse } from "../shared/tags";

describe("titleInitials", () => {
  it("takes up to three significant words, a hyphenated word counting once", () => {
    expect(titleInitials("Air-fryer crispy tofu")).toBe("ACT");
    expect(titleInitials("Autumn kale and apple salad with apple cider vinaigrette")).toBe("AKA");
    expect(titleInitials("Soy protein chickpea waffles")).toBe("SPC");
  });
  it("drops filler words and parentheticals", () => {
    expect(titleInitials("The best of the dal (instant pot style)")).toBe("BD");
    expect(titleInitials("Pasta in a tomato sauce")).toBe("PTS");
    expect(titleInitials("Korean-style tofu for two")).toBe("KTT");
  });
  it("ignores punctuation around words and keeps non-ASCII letters", () => {
    expect(titleInitials('"Ödön\'s" & éclair')).toBe("ÖÉ");
    expect(titleInitials("granola")).toBe("G");
  });
  it("falls back to the first character when every word is filler", () => {
    expect(titleInitials("The and")).toBe("T");
  });
});

describe("primaryCourse", () => {
  it("picks the first course in the fixed order, whatever order the tags are in", () => {
    expect(primaryCourse(["diet:vegan", "course:side", "course:main"])).toBe("main");
    expect(primaryCourse(["course:sauce", "course:breakfast"])).toBe("breakfast");
    expect(primaryCourse(["course:drink"])).toBe("drink");
  });
  it("is undefined without a course tag", () => {
    expect(primaryCourse(["cuisine:thai"])).toBeUndefined();
  });
});

const recipe = (over: Partial<RecipeInput> = {}): RecipeInput => ({
  title: "Red lentil dal",
  sections: [{ ingredients: [{ item: "red lentils" }, { item: "coconut milk" }] }, { title: "Tadka", ingredients: [{ item: "cumin seeds" }] }],
  steps_md: "1. Simmer the **red lentils**.\n2. Serve with the [tadka](https://example.com) on top.",
  notes_md: "",
  tags: ["course:main"],
  ...over,
});

describe("coverPrompt", () => {
  it("names the dish, every ingredient, the plain last step and the container", () => {
    expect(coverPrompt(recipe())).toBe(
      'Realistic home-cooked photo of the finished dish "Red lentil dal". Ingredients: red lentils, coconut milk, cumin seeds. How it is served: Serve with the tadka on top. Show only what these ingredients make, nothing extra on the plate. A plain ceramic plate or bowl on a light wooden table, soft daylight, 45 degree angle. No text, no letters, no logos, no people, no hands.',
    );
  });
  it("strips paragraph numbering and ends the step with a period", () => {
    expect(coverPrompt(recipe({ steps_md: "Step 1: Mix.\n\nStep 2: Pour into glasses" }))).toContain("How it is served: Pour into glasses. Show");
  });
  it("skips the serving sentence when the last step only rests, chills or stores the dish", () => {
    for (const last of [
      "Chill for 2 hours.",
      "Let cool completely, then store in a jar.",
      "Refrigerate overnight.",
      "Freeze in portions.",
      "Let it rest 10 minutes.",
    ]) {
      const p = coverPrompt(recipe({ steps_md: `1. Mix.\n2. ${last}` }));
      expect(p, last).not.toContain("How it is served");
      expect(p).toContain("cumin seeds. Show only");
    }
  });
  it("keeps a chilling step that also says how it is served", () => {
    expect(coverPrompt(recipe({ steps_md: "Chill and serve with mint." }))).toContain("How it is served: Chill and serve with mint.");
  });
  it("leaves out the serving sentence without steps", () => {
    expect(coverPrompt(recipe({ steps_md: "" }))).toContain("cumin seeds. Show only");
  });
  it("picks the container from the primary course", () => {
    const container = (tags: string[]) => / ([^.]*) on a light wooden table/.exec(coverPrompt(recipe({ tags })))![1];
    expect(container(["course:drink"])).toBe("A glass");
    expect(container(["course:soup", "course:main"])).toBe("A plain ceramic plate or bowl");
    expect(container(["course:soup"])).toBe("A bowl");
    expect(container(["course:dessert"])).toBe("A plate or small bowl");
    expect(container(["course:breakfast", "course:snack"])).toBe("A plate or small bowl");
    expect(container(["course:baking"])).toBe("A plate or small bowl");
    expect(container(["course:salad"])).toBe("A plain ceramic plate or bowl");
    expect(container([])).toBe("A plain ceramic plate or bowl");
  });
  it("cuts a long ingredient list at a whole item to stay within the model's limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ item: `ingredient number ${i} with a fairly long name` }));
    const p = coverPrompt(recipe({ sections: [{ ingredients: many }], steps_md: `Serve ${"warm ".repeat(300)}` }));
    expect(p.length).toBeLessThanOrEqual(MAX_PROMPT);
    expect(p).toMatch(/with a fairly long name\. How it is served/);
    expect(p).toMatch(/no hands\.$/);
  });
});
