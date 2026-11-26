import { describe, expect, it } from "vitest";
import { lintRecipe } from "../shared/lint";
import type { Ingredient, RecipeInput, Section } from "../shared/schema";
import { linkSteps, type Span, statedAmounts } from "../shared/stepLinks";
import { renderStep, stepMarks } from "../src/lib/stepHtml";

const g = (item: string, qty: number, unit: Ingredient["unit"] = "g", more: Partial<Ingredient> = {}): Ingredient => ({ item, qty, unit, ...more });

const cake: Section[] = [
  { title: "Cake", ingredients: [g("flour", 300), g("butter", 75), g("sugar", 150)] },
  { title: "Swirl", ingredients: [g("butter", 120), g("cinnamon", 2, "tbsp")] },
  { title: "Frosting", ingredients: [g("butter", 100), g("cream cheese", 200), g("pudding mix", 1, "piece")] },
];

/** The words each span covers, with what it resolved to. */
function read(sections: Section[], step: string): string[] {
  return linkSteps(sections, [step])[0]!.map((s: Span) => {
    const word = step.slice(s.from, s.to);
    if (s.kind === "section") return `${word} -> section ${sections[s.section]!.title}`;
    if (s.kind === "ambiguous") return `${word} -> ${s.lines.map((l) => `${l.qty}${l.unit}`).join(" | ")}`;
    return `${word} -> ${s.line.qty}${s.line.unit}${s.partial ? " partial" : ""}`;
  });
}

describe("linkSteps", () => {
  it("takes the section the step names, otherwise walks the sections in order", () => {
    expect(read(cake, "For the swirl, brown the butter.")).toEqual(["swirl -> section Swirl", "butter -> 120g"]);
    expect(read(cake, "Beat the butter and sugar.")).toEqual(["butter -> 75g", "sugar -> 150g"]);
    const steps = ["Beat the butter and sugar.", "Stir the cinnamon into the butter.", "Beat the butter with the cream cheese."];
    expect(linkSteps(cake, steps).map((s) => s.map((x) => (x.kind === "ingredient" ? x.line.qty : x.kind)))).toEqual([
      [75, 150],
      [2, 120],
      [120, 200],
    ]);
  });

  it("does not link a compound noun such as butter mixture", () => {
    expect(read(cake, "Spread the butter mixture over the dough.")).toEqual([]);
  });

  it("links a section reference to the section", () => {
    const sauce: Section[] = [
      { title: "Dough", ingredients: [g("flour", 200)] },
      { title: "Sauce", ingredients: [g("tomato", 400), g("garlic", 2, "clove")] },
    ];
    expect(read(sauce, "Mix all sauce ingredients.")).toEqual(["sauce -> section Sauce"]);
  });

  it("links nothing when the step already says the amount", () => {
    expect(read([{ ingredients: [g("olive oil", 2, "tbsp")] }], "Heat 2 tbsp olive oil.")).toEqual([]);
  });

  it("marks a partial mention", () => {
    expect(read(cake.slice(0, 1), "Stir in the rest of the butter.")).toEqual(["butter -> 75g partial"]);
    expect(read(cake.slice(0, 1), "Add half the sugar.")).toEqual(["sugar -> 150g partial"]);
  });

  it("does not take a verb for an ingredient", () => {
    expect(read([{ ingredients: [g("pudding mix", 1, "piece")] }], "Mix until no streaks remain.")).toEqual([]);
    expect(read([{ ingredients: [g("pudding mix", 1, "piece")] }], "Whisk the pudding mix.")).toEqual(["pudding mix -> 1piece"]);
  });

  it("consumes repeated lines of one item in list order", () => {
    const oil: Section[] = [
      { ingredients: [g("olive oil", 2, "tbsp", { note: "for searing" }), g("olive oil", 1, "tbsp", { note: "for the shallots" }), g("shallot", 2, "piece")] },
    ];
    expect(read(oil, "Sear the chicken in the olive oil.")).toEqual(["olive oil -> 2tbsp"]);
    const steps = ["Sear the chicken in the olive oil.", "Soften the shallots in the olive oil.", "Serve with olive oil."];
    expect(linkSteps(oil, steps).map((s) => s.map((x) => (x.kind === "ingredient" ? x.line.qty : x.kind)))).toEqual([[2], [2, 1], [1]]);
  });
});

describe("statedAmounts", () => {
  const sections: Section[] = [{ ingredients: [g("butter", 75), g("garlic", 2, "clove"), g("canned tomato", 400)] }];
  it("finds an amount before an ingredient word, or a g/ml/tbsp/tsp amount anywhere", () => {
    expect(statedAmounts(sections, "Beat 75 g butter.")).toEqual(["75 g"]);
    expect(statedAmounts(sections, "Add 2 cloves of garlic.")).toEqual(["2 cloves"]);
    expect(statedAmounts(sections, "Stir in 1 tbsp of it.")).toEqual(["1 tbsp"]);
  });
  it("leaves temperatures, times and pans alone", () => {
    expect(statedAmounts(sections, "Bake at 180 °C for 25 min in a 20 cm tin, then wait 2 l of steam to go.")).toEqual([]);
  });
});

const recipe = (steps_md: string, sections: Section[], tags: string[] = ["course:main", "cuisine:indian", "method:one-pot"]): RecipeInput => ({
  title: "Test dal",
  sections,
  steps_md,
  notes_md: "",
  tags,
});
const lint = (r: RecipeInput, review: string[] = []) => lintRecipe({ recipe: r, review });

describe("lintRecipe step rules", () => {
  const sections: Section[] = [{ ingredients: [g("red lentils", 200), g("butter", 20), { item: "salt", note: "to taste" }] }];
  it("accepts steps that name each ingredient without an amount", () => {
    expect(lint(recipe("1. Rinse the lentils.\n2. Fry in the butter.\n3. Season with salt.", sections))).toEqual([]);
  });
  it("names an ingredient with an amount that no step uses", () => {
    expect(lint(recipe("1. Rinse the lentils.\n2. Season with salt.", sections))).toEqual([
      'no step names ingredient "butter": name it in the step that uses it',
    ]);
  });
  it("counts a section reference as naming the section's ingredients", () => {
    const two: Section[] = [
      { title: "Sauce", ingredients: [g("tomato", 400), g("garlic", 2, "clove")] },
      { title: "Pasta", ingredients: [g("penne", 300)] },
    ];
    expect(lint(recipe("1. Boil the penne.\n2. Mix all sauce ingredients.", two))).toEqual([]);
  });
  it("names the step that states an amount", () => {
    expect(lint(recipe("1. Rinse the lentils.\n2. Fry in 20 g butter.\n3. Season with salt.", sections))).toContain(
      'step 2 states an amount ("20 g"): amounts live only in the ingredient list, name the ingredient instead',
    );
  });
  it("wants a second olive oil line to be named by a second mention", () => {
    const oil: Section[] = [{ ingredients: [g("olive oil", 2, "tbsp", { note: "for searing" }), g("olive oil", 1, "tbsp", { note: "for the shallots" })] }];
    expect(lint(recipe("1. Sear in the olive oil.", oil))).toEqual([
      'no step names ingredient "olive oil" (for the shallots): name it in the step that uses it',
    ]);
    expect(lint(recipe("1. Sear in the olive oil.\n2. Soften the shallots in the olive oil.", oil))).toEqual([]);
  });
  it("exempts stubs and recipes without steps", () => {
    expect(lint(recipe("", sections))).not.toContainEqual(expect.stringContaining("no step names"));
    const stub = { ...recipe("1. Cook it with 20 g of it.", sections), source_url: "https://example.com/dal" };
    expect(lint(stub, ["stub"])).toEqual([]);
  });
});

describe("renderStep", () => {
  const sections: Section[] = [{ ingredients: [g("butter", 75), g("sugar", 150), { item: "salt", note: "to taste" }] }];
  const marks = (step: string) => stepMarks(linkSteps(sections, [step])[0]!, sections, new Set());
  const html = (step: string, pills = true) => renderStep(step, marks(step), () => pills);

  it("wraps the word and adds the amount pill after it", () => {
    expect(html("Beat the butter and sugar.")).toBe(
      'Beat the <span class="ing" data-s="0">butter</span><span class="amt">75 g</span> and <span class="ing" data-s="1">sugar</span><span class="amt">150 g</span>.',
    );
  });
  it("leaves the pill out until it is shown", () => {
    expect(html("Beat the butter.", false)).toBe('Beat the <span class="ing" data-s="0">butter</span>.');
  });
  it("keeps bold around a word, and gives no mark to lines without a qty", () => {
    expect(html("Beat the **butter** with salt.")).toBe(
      'Beat the <strong><span class="ing" data-s="0">butter</span><span class="amt">75 g</span></strong> with salt.',
    );
  });
  it("drops a span inside a link or code and keeps the link", () => {
    expect(html("See [the butter](https://x.example/b) now.")).toBe('See <a href="https://x.example/b">the butter</a> now.');
    expect(html("Run `butter` now.")).toBe("Run <code>butter</code> now.");
  });
  it("marks a section covered only when the steps name each of its lines with a qty", () => {
    const two: Section[] = [
      { title: "Dough", ingredients: [g("flour", 400), { item: "salt" }] },
      { title: "Sauce", ingredients: [g("tahini", 15)] },
    ];
    const steps = ["Knead the flour.", "Spread the dough.", "Pour over the sauce."];
    const spans = linkSteps(two, steps);
    const named = new Set(spans.flat().flatMap((s) => (s.kind === "ingredient" ? [s.line.n] : [])));
    const sec = (i: number) => stepMarks(spans[i]!, two, named).find((m) => m.kind === "sec");
    expect(sec(1)?.covered).toBe(true);
    expect(sec(2)?.covered).toBe(false);
  });
  it("never lets recipe text become markup", () => {
    expect(html('Beat the butter <img src=x onerror="alert(1)">')).not.toContain("<img");
  });
});
