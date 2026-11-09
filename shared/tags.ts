/**
 * The tag scheme, defined once. Every tag is "group:value" with a lowercase kebab value. Lint,
 * zod validation, the MCP tools, the link-import prompt, NORMALIZE.md's vocabulary section, the
 * server-derived tags, the tag input and the list filter all read TAG_GROUPS. No zod here, so the
 * client bundle can import it.
 */

/**
 * `values`: the fixed values, or absent for a free group (any kebab value). `min`/`max`: how many
 * tags of the group a recipe may carry (checked for content writers). `content`: whether whoever
 * writes the recipe content (the import normalizer, MCP, the link import model) may set it;
 * the other groups are derived by the server or set by people in the app.
 */
type GroupSpec = { values?: readonly string[]; min?: number; max?: number; content: boolean; about: string };

/** In display order: the list filter and the vocabulary show the groups in this order. */
export const TAG_GROUPS = {
  course: {
    values: ["breakfast", "main", "side", "salad", "soup", "snack", "dessert", "baking", "drink", "sauce", "basics"],
    min: 1,
    max: 2,
    content: true,
    about: "what kind of dish it is",
  },
  cuisine: {
    values: ["indian", "italian", "korean", "thai", "japanese", "laotian", "cambodian", "middle-eastern", "mexican", "german", "other"],
    max: 1,
    content: true,
    about: "only when the dish clearly belongs to one",
  },
  diet: { values: ["vegan", "vegetarian"], content: true, about: "only when the whole recipe as written is" },
  method: { values: ["oven", "airfryer", "instant-pot", "one-pot", "no-cook", "batch"], max: 3, content: true, about: "how it is cooked" },
  list: { content: false, about: "a plan or set of the owners, e.g. list:next-up, list:birthday" },
  collection: { content: true, about: "recipes split out of one source share one, e.g. collection:cottage-cheese-ideas" },
  status: { values: ["stub"], content: false, about: "set by the server: status:stub when the recipe is not written up" },
  todo: { values: ["method", "correction"], content: false, about: "work left: todo:method (set by the server when there are no steps), todo:correction" },
} as const satisfies Record<string, GroupSpec>;

export type TagGroup = keyof typeof TAG_GROUPS;
export const TAG_GROUP_NAMES = Object.keys(TAG_GROUPS) as TagGroup[];
const spec = (g: TagGroup): GroupSpec => TAG_GROUPS[g];

export const MAX_TAG_LENGTH = 40;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const STUB_TAG = "status:stub";
export const NEEDS_METHOD_TAG = "todo:method";

export const groupValues = (g: TagGroup): readonly string[] => spec(g).values ?? [];
export const isFixedGroup = (g: TagGroup): boolean => spec(g).values !== undefined;
export const isTagGroup = (g: string): g is TagGroup => Object.hasOwn(TAG_GROUPS, g);
export const makeTag = (group: TagGroup, value: string): string => `${group}:${value}`;
/** Every tag a fixed group allows, e.g. all "course:*". */
export const fixedTags = (g: TagGroup): string[] => groupValues(g).map((v) => makeTag(g, v));
/** The groups whose tags the content writer chooses. */
export const CONTENT_GROUPS = TAG_GROUP_NAMES.filter((g) => spec(g).content);

export type ParsedTag = { group: TagGroup; value: string };

/** Why `tag` is not a valid tag, or null. Messages are written for a model or a person to act on. */
export function tagProblem(tag: string): string | null {
  const i = tag.indexOf(":");
  if (i < 0) return `"${tag}" has no group: write group:value, e.g. course:main (groups: ${TAG_GROUP_NAMES.join(", ")})`;
  const group = tag.slice(0, i);
  const value = tag.slice(i + 1);
  if (!isTagGroup(group)) return `"${tag}": unknown group "${group}" (groups: ${TAG_GROUP_NAMES.join(", ")})`;
  const values = groupValues(group);
  if (isFixedGroup(group) && !values.includes(value)) return `"${tag}": ${group} is one of ${values.join(", ")}`;
  if (!KEBAB.test(value)) return `"${tag}": the value must be lowercase words joined by "-"`;
  if (tag.length > MAX_TAG_LENGTH) return `"${tag}": at most ${MAX_TAG_LENGTH} characters`;
  return null;
}

export function parseTag(tag: string): ParsedTag | null {
  if (tagProblem(tag) !== null) return null;
  const i = tag.indexOf(":");
  return { group: tag.slice(0, i) as TagGroup, value: tag.slice(i + 1) };
}

/** "needs 1-2 course tags, has 3" for every group outside its limits. Invalid tags are not counted. */
export function groupCountProblems(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of TAG_GROUP_NAMES) {
    const { min, max } = spec(g);
    const n = tags.filter((t) => parseTag(t)?.group === g).length;
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) out.push(`needs ${min ?? 0}-${max ?? "any"} ${g} tags, has ${n}`);
  }
  return out;
}

/** "course allows at most 2" for each group over its max. */
export function overMax(tags: readonly string[]): string[] {
  return TAG_GROUP_NAMES.flatMap((g) => {
    const { max } = spec(g);
    return max !== undefined && tags.filter((t) => parseTag(t)?.group === g).length > max ? [`${g} allows at most ${max}`] : [];
  });
}

/** The value part for display ("main" for "course:main"); the whole string for anything unparsable. */
export const tagValue = (tag: string): string => parseTag(tag)?.value ?? tag;
export const tagGroup = (tag: string): TagGroup | null => parseTag(tag)?.group ?? null;

/**
 * Tags from before the scheme (2026-11) with a fixed new name. Every other loose kebab tag of that
 * time was an owner's list, so `upgradeTag` makes it `list:<tag>`. The D1 migration
 * 0006_tag_groups.sql applies the same two rules (a test keeps them equal).
 */
export const LEGACY_TAGS: Readonly<Record<string, string>> = Object.fromEntries([
  ...(["course", "method", "cuisine"] as const).flatMap((g) => groupValues(g).map((v) => [v, makeTag(g, v)])),
  ["vegan", "diet:vegan"],
  ["stub", STUB_TAG],
  ["needs-method", NEEDS_METHOD_TAG],
  ["next-up", "list:next-up"],
]);

/**
 * Typed input: a legacy name is renamed, anything else is returned normalized. An unknown bare
 * word stays loose, so the caller can ask for a group instead of guessing one.
 */
export const renameLegacyTag = (tag: string): string => LEGACY_TAGS[normalizeTag(tag)] ?? normalizeTag(tag);

/**
 * Tags written by an old build (restored revisions, cached recipes, queued tag edits): renamed, and
 * any other loose kebab tag becomes `list:<tag>`. What is still loose after that is no tag at all.
 */
export function upgradeTag(tag: string): string {
  const t = renameLegacyTag(tag);
  return !t.includes(":") && KEBAB.test(t) ? makeTag("list", t) : t;
}
/** Legacy names mapped, duplicates dropped, order kept. Unknown loose tags stay; see `onlyValidTags`. */
export const upgradeTags = (tags: readonly string[]): string[] => [...new Set(tags.map(upgradeTag))];
/** Upgraded, and anything that is still not a valid tag dropped (a restore never brings back a loose tag). */
export const onlyValidTags = (tags: readonly string[]): string[] => upgradeTags(tags).filter((t) => tagProblem(t) === null);

/** One line per group, as NORMALIZE.md, the MCP guide and the link-import prompt show it. */
export function vocabularyLines(groups: readonly TagGroup[] = TAG_GROUP_NAMES): string[] {
  return groups.map((g) => {
    const s = spec(g);
    const limit = s.content ? `${s.min ?? 0}-${s.max ?? "n"}` : "never set by you";
    const values = s.values ? s.values.join(", ") : "free value";
    return `- \`${g}\` (${limit}): ${values}. ${s.about[0]!.toUpperCase()}${s.about.slice(1)}.`;
  });
}

export type TagDelta = { add: readonly string[]; remove: readonly string[] };

export const normalizeTag = (t: string): string => t.trim().toLowerCase();

/**
 * Apply an add/remove delta to a tag list. Idempotent: adding a tag that is already there
 * and removing one that is missing are no-ops, so replaying an op is harmless and
 * concurrent edits by two people merge instead of overwriting each other.
 * Removes are applied before adds; existing order is kept and new tags go at the end.
 */
export function applyTagDelta(tags: readonly string[], delta: TagDelta): string[] {
  const remove = new Set(delta.remove.map(normalizeTag));
  const out = tags.filter((t) => !remove.has(t));
  for (const raw of delta.add) {
    const t = normalizeTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
