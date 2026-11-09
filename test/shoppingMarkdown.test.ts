import { describe, expect, it } from "vitest";
import { groupShopping } from "../shared/shopping";
import { shoppingToMarkdown } from "../src/lib/shoppingMarkdown";

const item = (id: string, item: string, extra: object = {}) => ({ id, item, checked: false, updated_at: "2026-11-09T10:00:00.000Z", ...extra });

describe("shoppingToMarkdown", () => {
  it("lists the recipes, then a checkbox per item with a link to its recipe", () => {
    const groups = groupShopping([
      item("a", "red lentils", { qty: 400, unit: "g", recipe_id: "dal", recipe_title: "Dal" }),
      item("b", "milk", { checked: true }),
      item("c", "red lentils", { qty: 200, unit: "g", recipe_id: "soup", recipe_title: "Soup" }),
    ]);
    const md = shoppingToMarkdown(groups, "https://fd.example", "2026-11-09");
    expect(md).toContain("# Shopping list 2026-11-09");
    expect(md).toContain("## Recipes\n\n- [Dal](https://fd.example/recipes/dal)\n- [Soup](https://fd.example/recipes/soup)\n");
    expect(md).toContain("- [ ] 400 g red lentils - https://fd.example/recipes/dal");
    expect(md).toContain("- [ ] 200 g red lentils - https://fd.example/recipes/soup");
    expect(md).toContain("- [x] milk\n");
  });
  it("leaves out the recipes section when nothing came from a recipe", () => {
    expect(shoppingToMarkdown(groupShopping([item("b", "milk")]), "https://fd.example", "d")).not.toContain("## Recipes");
  });
});
