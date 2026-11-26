/**
 * Which ingredients a recipe step names, found from the recipe's own ingredient list at render time.
 * The cooking view shows each hit's amount next to the word, and the lint (shared/lint.ts) holds
 * writers to steps that name what they use and never state an amount themselves. Nothing is stored.
 * No zod here, so the client bundle can import it.
 */
import { candidateNames, itemKey, singularize } from "./catalogue";
import type { Ingredient, Section } from "./schema";

/** An ingredient line with its position: `section` is the section index, `n` the index over all lines. */
export type Line = Ingredient & { section: number; n: number };

/** A mention in one step: `from`/`to` are offsets into the step text. */
export type Span = { from: number; to: number } & (
  | { kind: "ingredient"; line: Line; partial: boolean }
  | { kind: "ambiguous"; lines: Line[] }
  | { kind: "section"; section: number }
);

type Entry = { rank: number } & ({ lines: Line[] } | { section: number });
const RANK = { exact: 3, section: 2, suffix: 1 };
const TITLE_STOP = new Set(["to", "the", "and", "for", "a", "of", "other", "final", "base", "serve", "finish", "assemble", "balance", "preparation"]);
const PARTIAL = new Set(["half", "remaining", "rest", "some", "more", "extra", "third", "quarter", "reserved", "little"]);
const AFTER_COMPOUND = new Set(["sauce", "mixture", "dough", "batter", "dressing", "topping", "glaze", "marinade"]);
const VERB_SUFFIX = new Set(["mix", "top", "rub", "dip", "dust"]);

/** Singular, and a final "y" read as "i", so "chilies" (singular "chily") meets "chili". Both sides go through it. */
const word = (raw: string): string => singularize(itemKey(raw)).replace(/(?<=..)y$/, "i");
const tokenize = (s: string) => [...s.matchAll(/[\p{L}'-]+|\d+(?:[.,/]\d+)?/gu)].map((m) => ({ w: word(m[0]), at: m.index!, end: m.index! + m[0].length }));
const key = (s: string) =>
  tokenize(s)
    .map((t) => t.w)
    .join(" ");

type Dictionary = { dict: Map<string, Entry>; lines: Line[]; titles: Set<string>[]; maxLen: number };

function dictionary(sections: Section[]): Dictionary {
  const lines: Line[] = sections.flatMap((s, section) => s.ingredients.map((g) => ({ ...g, section, n: 0 })));
  lines.forEach((l, n) => {
    l.n = n;
  });
  const dict = new Map<string, Entry>();
  const add = (k: string, rank: number, target: { line: Line } | { section: number }) => {
    if (!k) return;
    const e = dict.get(k);
    if ("section" in target) {
      if (!e || e.rank < rank) dict.set(k, { rank, section: target.section });
    } else if (!e || e.rank < rank) dict.set(k, { rank, lines: [target.line] });
    else if (e.rank === rank && "lines" in e && !e.lines.includes(target.line)) e.lines.push(target.line);
  };
  for (const l of lines) {
    for (const name of [l.item, l.base ?? "", ...candidateNames(l.item)]) add(key(name), RANK.exact, { line: l });
    const words = key(l.item).split(" ");
    for (let k = 1; k < words.length; k++) if (!VERB_SUFFIX.has(words.slice(k).join(" "))) add(words.slice(k).join(" "), RANK.suffix, { line: l });
  }
  const titles = sections.map(
    (s) =>
      new Set(
        key(s.title ?? "")
          .split(" ")
          .filter((w) => w && !TITLE_STOP.has(w)),
      ),
  );
  titles.forEach((t, section) => {
    if (sections.length < 2 || !t.size) return;
    add([...t].join(" "), RANK.section, { section });
    add([...t].at(-1)!, RANK.section, { section });
  });
  const maxLen = Math.max(1, ...[...dict.keys()].map((k) => k.split(" ").length));
  return { dict, lines, titles, maxLen };
}

/** The longest dictionary entry starting at token i: [entry, token count]. */
function longestAt(d: Dictionary, toks: { w: string }[], i: number): [Entry, number] | undefined {
  for (let n = Math.min(d.maxLen, toks.length - i); n > 0; n--) {
    const e = d.dict.get(
      toks
        .slice(i, i + n)
        .map((t) => t.w)
        .join(" "),
    );
    if (e) return [e, n];
  }
  return undefined;
}

/** The sections a step names by their title ("for the swirl"), found as section matches, not as any shared word. */
function sectionsNamed(d: Dictionary, toks: { w: string }[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < toks.length; ) {
    const hit = longestAt(d, toks, i);
    if (hit && "section" in hit[0]) out.push(hit[0].section);
    i += hit ? hit[1] : 1;
  }
  return out;
}

/**
 * Spans for every step of one recipe. A mention names the line it belongs to: a section title in the
 * step picks that section's line, otherwise `pointer` walks the sections in order. Mentions of an item
 * that has several lines in one section take those lines in list order.
 */
export function linkSteps(sections: Section[], steps: string[]): Span[][] {
  const d = dictionary(sections);
  let pointer = 0;
  const consumed = new Set<Line>();
  return steps.map((step) => {
    const toks = tokenize(step.replace(/^\s*\d+[.)]\s*/, (m) => " ".repeat(m.length)));
    const named = sectionsNamed(d, toks);
    const spans: Span[] = [];
    for (let i = 0; i < toks.length; ) {
      const hit = longestAt(d, toks, i);
      if (!hit) {
        i++;
        continue;
      }
      const [e, n] = hit;
      const said = toks
        .slice(i, i + n)
        .map((t) => t.w)
        .join(" ");
      const from = toks[i]!.at;
      const to = toks[i + n - 1]!.end;
      const before = toks.slice(Math.max(0, i - 3), i).map((t) => t.w);
      const next = toks[i + n]?.w;
      i += n;
      if ("section" in e) {
        spans.push({ kind: "section", section: e.section, from, to });
        continue;
      }
      if (next && AFTER_COMPOUND.has(next)) continue;
      if (before.some((w) => /^\d/.test(w))) continue;
      let cand = e.lines;
      const sectionsHit = new Set(cand.map((l) => l.section));
      if (sectionsHit.size > 1) {
        const byTitle = cand.filter((l) => named.includes(l.section));
        const titled = new Set(byTitle.map((l) => l.section));
        if (titled.size === 1) cand = byTitle;
        else {
          const ahead = cand.filter((l) => l.section >= pointer);
          const unused = ahead.filter((l) => !consumed.has(l));
          cand = unused.length ? unused : ahead;
        }
        if (!cand.length) cand = e.lines;
        else if (cand !== byTitle) cand = cand.filter((l) => l.section === cand[0]!.section);
      }
      if (cand.length > 1 && new Set(cand.map((l) => l.section)).size === 1) {
        const exact = cand.filter((l) => key(l.item) === said);
        const same = exact.length ? exact : cand.filter((l) => key(l.item) === key(cand[0]!.item));
        cand = [same.find((l) => !consumed.has(l)) ?? same.at(-1)!];
      }
      if (cand.length === 1) {
        const line = cand[0]!;
        consumed.add(line);
        pointer = Math.max(pointer, line.section);
        spans.push({ kind: "ingredient", line, partial: before.some((w) => PARTIAL.has(w)), from, to });
      } else spans.push({ kind: "ambiguous", lines: cand, from, to });
    }
    return spans;
  });
}

/** Every line (with a qty) a set of spans names, a section reference naming all of its lines. */
export function namedLines(sections: Section[], spans: readonly Span[]): Set<number> {
  const d = dictionary(sections);
  const out = new Set<number>();
  for (const s of spans) {
    if (s.kind === "ingredient") out.add(s.line.n);
    else if (s.kind === "ambiguous") for (const l of s.lines) out.add(l.n);
    else for (const l of d.lines) if (l.section === s.section) out.add(l.n);
  }
  return out;
}

/** A number with a unit. It is an ingredient amount only when an ingredient name follows ("75 g butter"), not "600 g of the dough" or "a bowl holding 360 ml". */
const AMOUNT = /(?<![\p{L}\d.,/])\d+(?:[.,]\d+)?(?:\/\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(g|kg|ml|l|tbsp|tsp|cups?|cloves?|pinch(?:es)?|cans?)(?![\p{L}])/giu;

/** The ingredient amounts a step states itself ("75 g butter"), which belong in the ingredient list. */
export function statedAmounts(sections: Section[], step: string): string[] {
  const d = dictionary(sections);
  const out: string[] = [];
  for (const m of step.matchAll(AMOUNT)) {
    const after = tokenize(step.slice(m.index! + m[0].length)).slice(0, 4);
    if (
      after.some((_, i) => {
        const hit = longestAt(d, after, i);
        return hit !== undefined && "lines" in hit[0];
      })
    )
      out.push(m[0]);
  }
  return out;
}
