import { describe, expect, it } from "vitest";
import { lintRecipe } from "../shared/lint";
import type { Ingredient, RecipeInput, Section } from "../shared/schema";
import { linkSteps, type Span, statedAmounts } from "../shared/stepLinks";
import { isStepList } from "../shared/steps";
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
  it("takes the section the step names, otherwise the next section's line no step used yet", () => {
    expect(read(cake, "For the swirl, brown the butter.")).toEqual(["swirl -> section Swirl", "butter -> 120g"]);
    expect(read(cake, "Beat the butter and sugar.")).toEqual(["butter -> 75g", "sugar -> 150g"]);
    const steps = ["Beat the butter and sugar.", "Stir the cinnamon into the butter.", "Beat the butter with the cream cheese."];
    expect(linkSteps(cake, steps).map((s) => s.map((x) => (x.kind === "ingredient" ? x.line.qty : x.kind)))).toEqual([
      [75, 150],
      [2, 120],
      [100, 200],
    ]);
  });

  it("reads plurals ending in -ies as the -i singular", () => {
    const chili: Section[] = [{ ingredients: [g("dried red chili", 4, "piece"), g("green chilli", 2, "piece")] }];
    expect(read(chili, "Fry the chilies, then the chillies.")).toEqual(["chilies -> 4piece", "chillies -> 2piece"]);
  });

  it("resolves an item with equal amounts in two sections by section title, then step order", () => {
    const oats: Section[] = [
      { title: "Oats", ingredients: [g("cinnamon", 1, "tsp"), g("oats", 50)] },
      { title: "Cinnamon swirl", ingredients: [g("butter", 10), g("cinnamon", 1, "tsp")] },
    ];
    const spans = linkSteps(oats, ["Soak the oats with the cinnamon.", "Stir the butter with the cinnamon."]);
    expect(spans.map((s) => s.flatMap((x) => (x.kind === "ingredient" ? [`${x.line.item}@${x.line.section}`] : [])))).toEqual([
      ["oats@0", "cinnamon@0"],
      ["butter@1", "cinnamon@1"],
    ]);
  });

  it("does not count an ingredient word as naming a section with that word in its title", () => {
    const oats: Section[] = [
      { ingredients: [g("oats", 80), g("cinnamon", 1, "tsp")] },
      { title: "Cinnamon swirl", ingredients: [g("light butter", 3), g("cinnamon", 2, "tsp")] },
    ];
    const spans = linkSteps(oats, ["Mix the oats and cinnamon.", "Stir the butter with the cinnamon."]);
    expect(spans.map((s) => s.flatMap((x) => (x.kind === "ingredient" ? [x.line.qty] : [])))).toEqual([
      [80, 1],
      [3, 2],
    ]);
  });

  it("prefers the line whose name is exactly the word, over one that only reduces to it", () => {
    const soda: Section[] = [{ ingredients: [g("cold water", 800, "ml"), g("honey", 30), g("water", 40, "ml")] }];
    expect(read(soda, "Warm the water and dissolve the honey in it.")).toEqual(["water -> 40ml", "honey -> 30g"]);
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

  const qtys = (sections: Section[], steps: string[]) =>
    linkSteps(sections, steps).map((s) => s.map((x) => (x.kind === "ingredient" ? x.line.qty : x.kind === "ambiguous" ? x.lines.map((l) => l.qty) : x.kind)));

  it("goes back to an earlier section's line when the later section's is used", () => {
    const pie: Section[] = [
      { title: "Dough", ingredients: [g("butter", 100), g("flour", 200)] },
      { title: "Filling", ingredients: [g("butter", 50), g("sugar", 80)] },
    ];
    expect(qtys(pie, ["For the filling, cream the butter and sugar.", "Rub the butter into the flour."])).toEqual([
      ["section", 50, 80],
      [100, 200],
    ]);
  });

  it("names the same line for the same words twice in one step, a second line only within its section", () => {
    const crumble: Section[] = [
      { title: "Crumble", ingredients: [g("butter", 75), g("flour", 150)] },
      { title: "Glaze", ingredients: [g("butter", 20)] },
    ];
    expect(qtys(crumble, ["Melt the butter, then pour the butter over the flour.", "Brush on the butter."])).toEqual([[75, 75, 150], [20]]);
    const oil: Section[] = [{ ingredients: [g("olive oil", 1, "tbsp"), g("olive oil", 2, "tbsp")] }];
    expect(qtys(oil, ["Brown half the wedges in the olive oil, then the rest in the olive oil."])).toEqual([[1, 2]]);
  });

  it("reads a number as the amount only right before the name, a bare count as a portion", () => {
    const veg: Section[] = [{ ingredients: [g("peas", 150), g("cream", 100, "ml"), g("egg", 2, "piece")] }];
    expect(read(veg, "Steam 2 min, add peas.")).toEqual(["peas -> 150g"]);
    expect(read(veg, "Simmer 10 min, add the cream.")).toEqual(["cream -> 100ml"]);
    expect(read(veg, "Heat 100 ml cream.")).toEqual([]);
    expect(read(veg, "Whisk 2 eggs.")).toEqual(["eggs -> 2piece partial"]);
  });

  it("does not take a verb, a generic word or a shared word at the end of section titles for the section", () => {
    const bake: Section[] = [
      { title: "Dry mix", ingredients: [g("flour", 200)] },
      { title: "Wet mix", ingredients: [g("milk", 200, "ml")] },
      { title: "Spice rub", ingredients: [g("paprika", 2, "tsp")] },
    ];
    expect(read(bake, "Mix until smooth.")).toEqual([]);
    expect(read(bake, "Rub the paprika in.")).toEqual(["paprika -> 2tsp"]);
    expect(read(bake, "Fold the wet mix into the dry mix.")).toEqual(["wet mix -> section Wet mix", "dry mix -> section Dry mix"]);
    const sauces: Section[] = [
      { title: "Pizza sauce", ingredients: [g("tomato", 400)] },
      { title: "Pasta sauce", ingredients: [g("cream", 200, "ml")] },
    ];
    expect(read(sauces, "Simmer the sauce.")).toEqual([]);
  });

  it("leaves different items sharing a word ambiguous, unless only one is named by that word", () => {
    const oils: Section[] = [{ ingredients: [g("olive oil", 2, "tbsp"), g("sesame oil", 1, "tsp")] }];
    expect(read(oils, "Heat the oil.")).toEqual(["oil -> 2tbsp | 1tsp"]);
    expect(read(oils, "Heat the sesame oil.")).toEqual(["sesame oil -> 1tsp"]);
    const herbs: Section[] = [{ ingredients: [g("ground coriander", 1, "tsp"), g("cilantro", 10, "g", { base: "coriander" })] }];
    expect(read(herbs, "Add the coriander.")).toEqual(["coriander -> 1tsp"]);
  });

  it("ignores words in a link's URL", () => {
    const sections: Section[] = [{ ingredients: [g("butter", 75)] }];
    expect(read(sections, "See [the recipe](https://x.example/butter/cake).")).toEqual([]);
  });
});

describe("statedAmounts", () => {
  const sections: Section[] = [{ ingredients: [g("butter", 75), g("garlic", 2, "clove"), g("canned tomato", 400)] }];
  it("finds an amount only before an ingredient word", () => {
    expect(statedAmounts(sections, "Beat 75 g butter.")).toEqual(["75 g"]);
    expect(statedAmounts(sections, "Add 2 cloves of garlic.")).toEqual(["2 cloves"]);
  });
  it("leaves amounts of intermediates, portions and containers alone", () => {
    const withDough: Section[] = [
      { title: "Dough", ingredients: [g("flour", 500)] },
      { title: "Filling", ingredients: [g("cheese", 200)] },
    ];
    expect(statedAmounts(withDough, "Roll 600 g of the dough out.")).toEqual([]);
    expect(statedAmounts(sections, "Pour off the fat, leaving about 2 tbsp in the pan.")).toEqual([]);
    expect(statedAmounts(sections, "Use a bowl holding at least 360 ml.")).toEqual([]);
  });
  it("leaves temperatures, times and pans alone", () => {
    expect(statedAmounts(sections, "Bake at 180 °C for 25 min in a 20 cm tin, then wait 2 l of steam to go.")).toEqual([]);
  });
  it("wants the name right after the unit, with at most of or the between", () => {
    const brine: Section[] = [{ ingredients: [g("brine", 1, "l"), g("salt", 0.5, "tsp")] }];
    expect(statedAmounts(brine, "Fill a 1 l jar with the brine.")).toEqual([]);
    expect(statedAmounts(brine, "Add 1 l of the brine.")).toEqual(["1 l"]);
  });
  it("finds unicode fractions and ranges", () => {
    const salt: Section[] = [{ ingredients: [g("salt", 0.5, "tsp"), g("olive oil", 1.5, "tbsp")] }];
    expect(statedAmounts(salt, "Add ½ tsp salt and 1½ tbsp olive oil.")).toEqual(["½ tsp", "1½ tbsp"]);
    expect(statedAmounts(sections, "Add 2-3 cloves garlic.")).toEqual(["2-3 cloves"]);
  });
  it("reads a bare count as a portion, not an amount", () => {
    expect(statedAmounts([{ ingredients: [g("lemon", 3, "piece")] }], "Squeeze 1-2 lemons.")).toEqual([]);
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
  it("accepts steps that go back to an earlier section, give times before a name or count a portion", () => {
    const pie: Section[] = [
      { title: "Dough", ingredients: [g("butter", 100), g("flour", 200)] },
      { title: "Filling", ingredients: [g("butter", 50), g("sugar", 80), g("peas", 100), g("egg", 2, "piece")] },
    ];
    const steps = "1. For the filling, cream the butter and sugar.\n2. Steam 2 min, add peas.\n3. Whisk 2 eggs.\n4. Rub the butter into the flour.";
    expect(lint(recipe(steps, pie))).toEqual([]);
  });
  it("does not count a word in a link's URL as naming the ingredient", () => {
    expect(lint(recipe("1. Rinse the lentils, see [the method](https://x.example/butter).\n2. Season with salt.", sections))).toEqual([
      'no step names ingredient "butter": name it in the step that uses it',
    ]);
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
  it("keeps the other marks of a step whose link URL holds an ingredient word", () => {
    expect(html("See [butter](https://x.example/butter) and butter.")).toBe(
      'See <a href="https://x.example/butter">butter</a> and <span class="ing" data-s="1">butter</span><span class="amt">75 g</span>.',
    );
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

describe("isStepList", () => {
  it("is true only for one numbered list of plain items, so rendering per item loses nothing", () => {
    expect(isStepList("1. Beat the butter.\n2. Add the sugar.")).toBe(true);
    expect(isStepList("1. Beat the butter.\n\n2. Add the sugar.")).toBe(true);
    expect(isStepList("1. Beat the butter.\n   - softened\n2. Add the sugar.")).toBe(false);
    expect(isStepList("1. Beat the butter.\n\n   Then rest it.\n2. Add the sugar.")).toBe(false);
    expect(isStepList("- Beat the butter.\n- Add the sugar.")).toBe(false);
    expect(isStepList("1. Beat the butter.\n2. Add the sugar.\n\nServe warm.")).toBe(false);
  });
});
