/**
 * Which ingredients a recipe step names, found from the recipe's own ingredient list at render time.
 * The cooking view shows each hit's amount next to the word, and the lint (shared/lint.ts) holds
 * writers to steps that name what they use and never state an amount themselves. Nothing is stored.
 * No zod here, so the client bundle can import it.
 */
import { candidateNames, itemKey, singularize } from "./catalogue";
import { METRIC_UNITS } from "./constants";
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
/** Words that are also kitchen verbs: never an item's last word alone ("pudding mix" is not "Mix ...") nor a section's. */
const VERBS = new Set(["mix", "top", "rub", "dip", "dust", "add", "stir", "fold", "blend", "toss", "coat", "drizzle", "sprinkle", "spread", "brush"]);
/**
 * Last words that never stand for a section title alone: generic ones ("Dry mix", "Sauce ingredients")
 * and verbs ("Spice rub" is not "Rub the meat"). "Dip" stays: "for the dip" names the "Herb quark dip".
 */
const NOT_A_TITLE_END = new Set([...[...VERBS].filter((w) => w !== "dip"), "ingredient", "mixture", "part"]);
const UNITS = new Set<string>([...METRIC_UNITS, "cup", "pinch", "can"]);
const FRACTION = "¼-¾⅐-⅞";
const NUMBER = new RegExp(`^(?:\\d|[${FRACTION}])`, "u");
const TOKEN = new RegExp(`[\\p{L}'-]+|\\d*[${FRACTION}]|\\d+(?:[.,/]\\d+)?`, "gu");

/** Singular, and a final "y" read as "i", so "chilies" (singular "chily") meets "chili". Both sides go through it. */
const word = (raw: string): string => singularize(itemKey(raw)).replace(/(?<=..)y$/, "i");
type Token = { w: string; at: number; end: number };
const tokenize = (s: string): Token[] => [...s.matchAll(TOKEN)].map((m) => ({ w: word(m[0]), at: m.index!, end: m.index! + m[0].length }));
const key = (s: string) =>
  tokenize(s)
    .map((t) => t.w)
    .join(" ");
const blank = (m: string) => " ".repeat(m.length);
/** A step's words, offsets kept, without its own list number or the URL part of links. */
const stepTokens = (step: string): Token[] =>
  tokenize(
    step
      .replace(/^\s*\d+[.)]\s*/, blank)
      .replace(/\]\([^)]*\)/g, blank)
      .replace(/<?https?:\/\/[^\s)>]*>?/g, blank),
  );

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
    for (let k = 1; k < words.length; k++) if (!VERBS.has(words.slice(k).join(" "))) add(words.slice(k).join(" "), RANK.suffix, { line: l });
  }
  const titles = sections.map(
    (s) =>
      new Set(
        key(s.title ?? "")
          .split(" ")
          .filter((w) => w && !TITLE_STOP.has(w)),
      ),
  );
  const lastWords = titles.map((t) => [...t].at(-1));
  titles.forEach((t, section) => {
    if (sections.length < 2 || !t.size) return;
    const words = [...t];
    add(words.join(" "), RANK.section, { section });
    const last = words.at(-1)!;
    const telling = !NOT_A_TITLE_END.has(last) && lastWords.filter((w) => w === last).length === 1;
    if (words.length > 1 && telling) add(last, RANK.section, { section });
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

/**
 * What the text says right before token i. `stated`: a number and a unit, with at most "of"/"the"
 * before the name ("75 g butter", "2 cloves of garlic"; not "a 1 l jar with the brine"). `count`: a
 * bare number right before the name ("set aside 4 cookies"; not "steam 2 min, add peas"), a portion.
 */
function amountBefore(text: string, toks: Token[], i: number): { stated?: string; count: boolean } {
  const tight = (a: number) => /^[\s\u2013]*$/.test(text.slice(toks[a]!.end, toks[a + 1]!.at));
  let j = i - 1;
  while (j >= 0 && (toks[j]!.w === "of" || toks[j]!.w === "the") && tight(j)) j--;
  const unit = j >= 0 && UNITS.has(toks[j]!.w) && tight(j) ? j : undefined;
  let k = unit === undefined ? i - 1 : unit - 1;
  if (k < 0 || !NUMBER.test(toks[k]!.w) || !tight(k)) return { count: false };
  if (unit === undefined) return { count: true };
  while (k > 0 && tight(k - 1) && (NUMBER.test(toks[k - 1]!.w) || (toks[k - 1]!.w === "-" && k > 1 && NUMBER.test(toks[k - 2]!.w))))
    k -= toks[k - 1]!.w === "-" ? 2 : 1;
  return { stated: text.slice(toks[k]!.at, toks[unit]!.end), count: false };
}

/** One dictionary hit in a step: its first token i, the words said, and what the text says before it. */
type Mention = { e: Entry; i: number; said: string; from: number; to: number; compound: boolean } & ReturnType<typeof amountBefore>;

function mentions(d: Dictionary, text: string, toks: Token[]): Mention[] {
  const out: Mention[] = [];
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
    const next = toks[i + n]?.w;
    out.push({
      e,
      i,
      said,
      from: toks[i]!.at,
      to: toks[i + n - 1]!.end,
      compound: next !== undefined && AFTER_COMPOUND.has(next),
      ...amountBefore(text, toks, i),
    });
    i += n;
  }
  return out;
}

/**
 * The line a mention of `lines` names. A section title in the step picks that section; otherwise the
 * first section with a line not used yet, at or after `pointer`, then anywhere, then a used one at or
 * after `pointer`. With every line used and behind the pointer, the mention fits them all.
 * Within one section, lines of one item go in list order. Different items sharing the word stay
 * ambiguous ("olive oil", "sesame oil" for "oil"), unless one is exactly the word said, or only some
 * end in it ("ground coriander" over "cilantro", whose base is coriander).
 */
function pick(lines: Line[], said: string, named: number[], pointer: number, consumed: ReadonlySet<Line>): Line | Line[] {
  let cand = lines;
  if (new Set(cand.map((l) => l.section)).size > 1) {
    const byTitle = cand.filter((l) => named.includes(l.section));
    if (new Set(byTitle.map((l) => l.section)).size === 1) cand = byTitle;
    else {
      const unused = cand.filter((l) => !consumed.has(l));
      const ahead = (ls: Line[]) => ls.filter((l) => l.section >= pointer);
      const choice = [ahead(unused), unused, ahead(cand)].find((c) => c.length);
      if (!choice) return cand;
      cand = choice.filter((l) => l.section === choice[0]!.section);
    }
  }
  if (cand.length === 1) return cand[0]!;
  const exact = cand.filter((l) => key(l.item) === said);
  const own = cand.filter((l) => ` ${key(l.item)}`.endsWith(` ${said}`));
  const pool = exact.length ? exact : own.length ? own : cand;
  if (!pool.every((l) => key(l.item) === key(pool[0]!.item))) return pool;
  return pool.find((l) => !consumed.has(l)) ?? pool.at(-1)!;
}

/**
 * Spans for every step of one recipe. A mention names the line it belongs to (see `pick`). The same
 * words again in one step stay in the section they named first: the next line of that item there if
 * the section has several (one per use), else the same line, never another section's.
 */
export function linkSteps(sections: Section[], steps: string[]): Span[][] {
  const d = dictionary(sections);
  let pointer = 0;
  const consumed = new Set<Line>();
  return steps.map((step) => {
    const toks = stepTokens(step);
    const found = mentions(d, step, toks);
    const named = found.flatMap((m) => ("section" in m.e ? [m.e.section] : []));
    const sectionOf = new Map<string, number>();
    const spans: Span[] = [];
    for (const m of found) {
      const { from, to } = m;
      if ("section" in m.e) {
        spans.push({ kind: "section", section: m.e.section, from, to });
        continue;
      }
      if (m.compound || m.stated) continue;
      const again = sectionOf.get(m.said);
      const lines = again === undefined ? m.e.lines : m.e.lines.filter((l) => l.section === again);
      const got = pick(lines, m.said, named, pointer, consumed);
      if (Array.isArray(got)) {
        spans.push({ kind: "ambiguous", lines: got, from, to });
        continue;
      }
      sectionOf.set(m.said, got.section);
      consumed.add(got);
      pointer = Math.max(pointer, got.section);
      const partial = m.count || toks.slice(Math.max(0, m.i - 3), m.i).some((t) => PARTIAL.has(t.w));
      spans.push({ kind: "ingredient", line: got, partial, from, to });
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

/** The ingredient amounts a step states itself ("75 g butter"), which belong in the ingredient list. A bare count ("4 cookies") is a portion, not one. */
export function statedAmounts(sections: Section[], step: string): string[] {
  const d = dictionary(sections);
  const toks = stepTokens(step);
  return mentions(d, step, toks).flatMap((m) => ("lines" in m.e && !m.compound && m.stated ? [m.stated] : []));
}
