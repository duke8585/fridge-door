/** Pure logic behind the tag combobox (editor and recipe page): normalization, suggestions, key handling. */
import { fixedTags, isFixedGroup, isTagGroup, TAG_GROUP_NAMES, renameLegacyTag, tagProblem, type TagGroup } from "../../shared/tags";

export const MAX_SUGGESTIONS = 8;

/**
 * What the user typed, as a tag-shaped string: lowercase, trimmed, a leading "#" dropped, spaces
 * around ":" removed and other whitespace turned into "-" ("List: next up" -> "list:next-up").
 */
export function normalizeTag(raw: string): string {
  return raw
    .replace(/^\s*#+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s*:\s*/, ":")
    .replace(/\s+/g, "-");
}

/** Appends a tag unless it is empty or already there. */
export function addTag(tags: readonly string[], tag: string): string[] {
  return tag === "" || tags.includes(tag) ? [...tags] : [...tags, tag];
}

/** How many recipes use each tag, over the whole library. */
export function tagCounts(tagLists: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const list of tagLists) for (const t of new Set(list)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/** `existing`: a fixed value or a tag in use (count 0 = valid but unused). `new`: a new value in a free group. */
export type TagOption = { kind: "existing"; tag: string; count: number } | { kind: "new"; tag: string };

const FREE_GROUPS = TAG_GROUP_NAMES.filter((g) => !isFixedGroup(g));
const groupOrder = (tag: string): number => TAG_GROUP_NAMES.indexOf(tag.slice(0, tag.indexOf(":")) as TagGroup);
const valueOf = (tag: string): string => tag.slice(tag.indexOf(":") + 1);

/** Every tag worth suggesting: all fixed values plus the valid tags in use, with their counts. */
function candidates(counts: ReadonlyMap<string, number>): Map<string, number> {
  const all = new Map<string, number>(TAG_GROUP_NAMES.flatMap(fixedTags).map((t) => [t, 0]));
  for (const [t, n] of counts) if (tagProblem(t) === null) all.set(t, n);
  return all;
}

/**
 * Suggestions for the typed text, without the tags already picked.
 * - Empty: the most used tags.
 * - "group:" or "group:val": only that group. A fixed group offers its values, a free group also
 *   a new value.
 * - A bare word: matched against the values of every group (prefix before substring, then by use).
 *   If no value is exactly that word, it needs a group: one "new" option per free group
 *   (list:<word>, collection:<word>).
 */
export function tagOptions(query: string, counts: ReadonlyMap<string, number>, selected: readonly string[], limit = MAX_SUGGESTIONS): TagOption[] {
  const q = normalizeTag(query);
  const all = candidates(counts);
  const open = [...all].filter(([t]) => !selected.includes(t));
  const byUse = (a: [string, number], b: [string, number]): number => b[1] - a[1] || groupOrder(a[0]) - groupOrder(b[0]) || a[0].localeCompare(b[0]);
  const existing = (list: [string, number][]): TagOption[] => list.slice(0, limit).map(([tag, count]) => ({ kind: "existing", tag, count }));

  if (q === "") return existing(open.filter(([, n]) => n > 0).sort(byUse));

  const colon = q.indexOf(":");
  const group = colon >= 0 ? q.slice(0, colon) : undefined;
  const value = colon >= 0 ? q.slice(colon + 1) : q;
  if (group !== undefined && !isTagGroup(group)) return [];
  const rank = (tag: string): number => (valueOf(tag).startsWith(value) ? 0 : valueOf(tag).includes(value) ? 1 : -1);
  const matches = open
    .filter(([t]) => (group === undefined || t.startsWith(`${group}:`)) && rank(t) >= 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || byUse(a, b));
  const out = existing(matches);

  const fresh = (tag: string): boolean => value !== "" && !all.has(tag) && !selected.includes(tag) && tagProblem(tag) === null;
  if (group !== undefined) return isFixedGroup(group) || !fresh(q) ? out : [...out, { kind: "new", tag: q }];
  if ([...all.keys()].some((t) => valueOf(t) === value)) return out;
  return [...out, ...FREE_GROUPS.map((g) => `${g}:${value}`).filter(fresh).map((tag): TagOption => ({ kind: "new", tag }))];
}

/**
 * The tag typed text stands for, without asking: a valid tag as typed, a legacy name ("vegan" ->
 * diet:vegan), or a bare word that is the value of exactly one known tag ("main" -> course:main).
 * undefined when it needs a group or is not valid.
 */
export function resolveTyped(text: string, counts: ReadonlyMap<string, number>): string | undefined {
  const q = normalizeTag(text);
  if (q === "") return undefined;
  if (tagProblem(q) === null) return q;
  const legacy = renameLegacyTag(q);
  if (tagProblem(legacy) === null) return legacy;
  const same = [...candidates(counts).keys()].filter((t) => valueOf(t) === q);
  return same.length === 1 ? same[0] : undefined;
}

/** active is -1 when nothing is highlighted (the list opened on focus, before any typing or arrow key). */
export type TagKeyState = { text: string; options: readonly TagOption[]; active: number; open: boolean; resolved: string | undefined };
export type TagKeyAction =
  | { type: "move"; active: number }
  | { type: "pick"; tag: string }
  | { type: "close" };

/**
 * What a key in the tag input does. undefined = let the browser handle it.
 * Arrows move (and open), Enter/Tab/comma pick the highlighted option, else what the typed text
 * resolves to; text that needs a group highlights the first suggestion instead of adding a loose
 * tag. Escape closes; Backspace never removes a chip (only the chip's own button does). Tab and Enter without
 * text keep their normal meaning.
 */
export function tagKey(key: string, s: TagKeyState): TagKeyAction | undefined {
  const n = s.options.length;
  const highlighted = s.open ? s.options[s.active] : undefined;
  switch (key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (n === 0) return undefined;
      if (!s.open || s.active < 0) return { type: "move", active: key === "ArrowDown" ? 0 : n - 1 };
      return { type: "move", active: (s.active + (key === "ArrowDown" ? 1 : -1) + n) % n };
    }
    case "Enter":
    case "Tab":
    case ",": {
      if (highlighted) return { type: "pick", tag: highlighted.tag };
      if (s.resolved) return { type: "pick", tag: s.resolved };
      if (s.text.trim() !== "") return n > 0 ? { type: "move", active: 0 } : { type: "close" };
      return key === "," ? { type: "close" } : undefined;
    }
    case "Escape":
      return s.open ? { type: "close" } : undefined;
    default:
      return undefined;
  }
}

/**
 * A comma that reached the input value (a paste, or an Android keyboard that sends no key event).
 * A single finished part takes the highlighted option, like a typed comma does. Otherwise each
 * part is resolved; the first part that needs a group stays in the input so its suggestions show.
 * undefined = no comma, keep typing.
 */
export function splitTyped(value: string, highlighted: TagOption | undefined, counts: ReadonlyMap<string, number>): { picks: string[]; text: string } | undefined {
  if (!value.includes(",")) return undefined;
  const parts = value.split(",");
  const rest = parts.pop()!;
  const done = parts.map((p) => p.trim()).filter(Boolean);
  if (done.length === 1 && highlighted) return { picks: [highlighted.tag], text: rest };
  const picks: string[] = [];
  const unresolved: string[] = [];
  for (const p of done) {
    const t = resolveTyped(p, counts);
    if (t) picks.push(t);
    else unresolved.push(p);
  }
  return { picks, text: unresolved[0] ?? rest };
}
