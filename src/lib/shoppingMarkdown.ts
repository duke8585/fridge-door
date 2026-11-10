/** The shopping list as a markdown file: the recipes on it, then one checkbox per item, by aisle. */
import { aisleLabel } from "../../shared/catalogue";
import { formatQty } from "../../shared/scale";
import type { AisleSection } from "../../shared/shopping";

/** `origin` is the app's address, for links back to each recipe. `date` goes into the heading. */
export function shoppingToMarkdown(sections: readonly AisleSection[], origin: string, date: string): string {
  const link = (id: string): string => `${origin}/recipes/${id}`;
  const recipes = new Map<string, string>();
  for (const s of sections) for (const g of s.groups) for (const l of g.lines) if (l.recipe_id) recipes.set(l.recipe_id, l.recipe_title ?? "Recipe");

  const out = [`# Shopping list ${date}`, ""];
  if (recipes.size) out.push("## Recipes", "", ...[...recipes].map(([id, title]) => `- [${title}](${link(id)})`), "");
  for (const s of sections) {
    out.push(`## ${aisleLabel(s.aisle)}`, "");
    for (const g of s.groups) {
      for (const l of g.lines) {
        const text = [formatQty(l.qty, l.qtyMax, l.unit), l.item.trim()].filter(Boolean).join(" ");
        out.push(`- [${l.checked ? "x" : " "}] ${text}${l.recipe_id ? ` - ${link(l.recipe_id)}` : ""}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

/** Saves `text` as a file: the browser's download, which iOS puts into Files. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
