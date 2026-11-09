/** The list page's tag filter: tags grouped for the filter bar, and matching. */
import { groupValues, isFixedGroup, parseTag, TAG_GROUP_NAMES, type TagGroup } from "../../shared/tags";

export type FilterGroup = { group: TagGroup; tags: { tag: string; count: number }[] };

/**
 * The tags in use, per group in the scheme's order (empty groups left out). Fixed groups keep
 * their vocabulary order, free groups go by use. Tags outside the scheme are not offered.
 */
export function filterGroups(tagLists: readonly (readonly string[])[]): FilterGroup[] {
  const counts = new Map<string, number>();
  for (const list of tagLists) for (const t of new Set(list)) if (parseTag(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return TAG_GROUP_NAMES.map((group) => {
    const order = groupValues(group);
    const tags = [...counts]
      .filter(([t]) => t.startsWith(`${group}:`))
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) =>
        isFixedGroup(group) ? order.indexOf(a.tag.slice(group.length + 1)) - order.indexOf(b.tag.slice(group.length + 1)) : b.count - a.count || a.tag.localeCompare(b.tag),
      );
    return { group, tags };
  }).filter((g) => g.tags.length > 0);
}

/** Any of the selected tags of a group (OR), and every group that has a selection (AND). */
export function matchesTagFilter(tags: readonly string[], selected: ReadonlySet<string>): boolean {
  const byGroup = new Map<string, string[]>();
  for (const t of selected) {
    const g = parseTag(t)?.group ?? t;
    byGroup.set(g, [...(byGroup.get(g) ?? []), t]);
  }
  return [...byGroup.values()].every((any) => any.some((t) => tags.includes(t)));
}

const groupOf = (t: string): string => parseTag(t)?.group ?? t;

/**
 * Facet counts: for each tag, how many recipes would match if it were added to the current
 * selection. Groups combine with AND, tags within a group with OR, so a tag's own group's
 * selection is left out when counting it (picking a second course widens, it never narrows).
 */
export function facetCounts(tagLists: readonly (readonly string[])[], selected: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  const groups = new Set([...selected].map(groupOf));
  for (const tags of tagLists) {
    // which selected groups this recipe fails; it counts for a tag only if that is at most the tag's own group
    const failing = [...groups].filter((g) => ![...selected].some((s) => groupOf(s) === g && tags.includes(s)));
    if (failing.length > 1) continue;
    for (const t of new Set(tags)) {
      if (failing.length === 0 || failing[0] === groupOf(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}
