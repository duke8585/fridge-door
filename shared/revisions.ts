/** Recipe versions: types shared by the Worker and the history page, and the diff between two versions. */
import type { Ingredient, RecipeInput, User } from "./schema";
import { formatQty } from "./scale";
import { onlyValidTags } from "./tags";
import { formatTime } from "./time";

/** "migration": written by a D1 migration (0006 tag groups), with no author. */
export type RevisionSource = "baseline" | "editor" | "tags" | "import" | "restore" | "mcp" | "url-import" | "migration";
/** A baseline is the content before the first recorded change, so nobody is its author. */
export type RevisionMeta = { id: number; author: User | null; source: RevisionSource; created_at: string };
export type Revision = RevisionMeta & { snapshot: RecipeInput };
/** `changes` summarizes what this version changed compared with the one before it. */
export type RevisionListItem = RevisionMeta & { changes: string[] };

/** The versioned part of a recipe. */
export const contentOf = (r: RecipeInput): RecipeInput => ({
  title: r.title,
  yield: r.yield,
  time: r.time,
  sections: r.sections,
  steps_md: r.steps_md,
  notes_md: r.notes_md,
  source_url: r.source_url,
  tags: r.tags,
});

/**
 * What restoring a snapshot writes. Snapshots from before the tag scheme keep their old tag names,
 * so they are upgraded, and a tag that is still not valid is dropped: a restore never brings back
 * a loose tag. The history page diffs against this too, so the preview matches the restore.
 */
export const restoredContent = (snapshot: RecipeInput): RecipeInput => ({ ...snapshot, tags: onlyValidTags(snapshot.tags) });

export type Change = { from: string; to: string };
export type LineOp = { op: "same" | "add" | "del"; text: string };
export type RecipeDiff = {
  title?: Change;
  yield?: Change;
  time?: Change;
  source_url?: Change;
  /** Section titles, " / "-joined. */
  sections?: Change;
  tags: { added: string[]; removed: string[] };
  ingredients: { added: string[]; removed: string[]; changed: Change[] };
  steps?: LineOp[];
  notes?: LineOp[];
};

export const ingredientLine = (i: Ingredient): string =>
  [formatQty(i.qty, i.qtyMax, i.unit), i.item].filter(Boolean).join(" ") + (i.prep ? `, ${i.prep}` : "") + (i.note ? ` (${i.note})` : "");

const field = (from: string, to: string): Change | undefined => (from === to ? undefined : { from, to });

/** Exact lines match first; what is left pairs up by item name as "changed". Section moves are not shown. */
function diffIngredients(from: readonly Ingredient[], to: readonly Ingredient[]): RecipeDiff["ingredients"] {
  const left = from.map((i) => ({ key: i.item.toLowerCase(), line: ingredientLine(i) }));
  const right: typeof left = [];
  for (const i of to) {
    const line = ingredientLine(i);
    const same = left.findIndex((l) => l.line === line);
    if (same >= 0) left.splice(same, 1);
    else right.push({ key: i.item.toLowerCase(), line });
  }
  const changed: Change[] = [];
  const added: string[] = [];
  for (const r of right) {
    const pair = left.findIndex((l) => l.key === r.key);
    if (pair < 0) added.push(r.line);
    else changed.push({ from: left.splice(pair, 1)[0]!.line, to: r.line });
  }
  return { added, removed: left.map((l) => l.line), changed };
}

/** Line diff by longest common subsequence. Recipes are short, so O(n*m) is fine. */
export function diffLines(from: string, to: string): LineOp[] {
  const a = from.split("\n");
  const b = to.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: "same", text: a[i++]! });
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ op: "del", text: a[i++]! });
    else out.push({ op: "add", text: b[j++]! });
  }
  return out;
}

const yieldText = (r: RecipeInput): string => (r.yield ? `${r.yield.amount} ${r.yield.unit}` : "");
const sectionTitles = (r: RecipeInput): string => r.sections.map((s) => s.title ?? "").join(" / ");

export function diffRecipes(from: RecipeInput, to: RecipeInput): RecipeDiff {
  return {
    title: field(from.title, to.title),
    yield: field(yieldText(from), yieldText(to)),
    time: field(from.time ? formatTime(from.time) : "", to.time ? formatTime(to.time) : ""),
    source_url: field(from.source_url ?? "", to.source_url ?? ""),
    sections: field(sectionTitles(from), sectionTitles(to)),
    tags: { added: to.tags.filter((t) => !from.tags.includes(t)), removed: from.tags.filter((t) => !to.tags.includes(t)) },
    ingredients: diffIngredients(
      from.sections.flatMap((s) => s.ingredients),
      to.sections.flatMap((s) => s.ingredients),
    ),
    steps: from.steps_md === to.steps_md ? undefined : diffLines(from.steps_md, to.steps_md),
    notes: from.notes_md === to.notes_md ? undefined : diffLines(from.notes_md, to.notes_md),
  };
}

const counts = (parts: [string, number][]): string => parts.filter(([, n]) => n > 0).map(([s, n]) => `${s}${n}`).join(" ");

/** ["title", "tags +vegan -quick", "ingredients +2 ~1", "steps"]. Empty when nothing changed. */
export function summarizeDiff(d: RecipeDiff): string[] {
  const out: string[] = [];
  if (d.title) out.push("title");
  if (d.yield) out.push("yield");
  if (d.time) out.push("time");
  if (d.source_url) out.push("source");
  if (d.sections) out.push("sections");
  const tags = [...d.tags.added.map((t) => `+${t}`), ...d.tags.removed.map((t) => `-${t}`)];
  if (tags.length) out.push(`tags ${tags.join(" ")}`);
  const ing = d.ingredients;
  const ingCounts = counts([["+", ing.added.length], ["-", ing.removed.length], ["~", ing.changed.length]]);
  if (ingCounts) out.push(`ingredients ${ingCounts}`);
  if (d.steps) out.push("steps");
  if (d.notes) out.push("notes");
  return out;
}
