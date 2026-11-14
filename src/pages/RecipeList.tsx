import { useEffect, useMemo, useState } from "react";
import { coverUrl, focusPosition } from "../../shared/cover";
import { searchRecipes } from "../../shared/search";
import { parseTag, type TagGroup } from "../../shared/tags";
import { formatMinutes, matchesTimeFilter, TIME_FILTERS } from "../../shared/time";
import { BookmarkButton, BookmarkIcon } from "../components/BookmarkButton";
import { AvgStars } from "../components/Stars";
import { TagChip } from "../components/TagChip";
import { ago } from "../lib/ago";
import { compareRecipes, DEFAULT_SORT, nextSort, SORTS, type Sort } from "../lib/recipeSort";
import { Link, navigate } from "../lib/router";
import { useSignal } from "../lib/signal";
import { facetCounts, filterGroups, matchesTagFilter } from "../lib/tagFilter";
import { currentUser } from "../lib/user";
import { catalogue } from "../store/catalogue";
import { loadSummaries, recentlyCached, setBookmark, summaries } from "../store/recipes";

/** Shown on the cards as the value alone; the other groups keep their prefix so "todo:method" is not read as a method. */
const CARD_VALUE_ONLY: ReadonlySet<TagGroup> = new Set(["course", "cuisine", "method", "diet"]);
const cardTag = (t: string): string => {
  const p = parseTag(t);
  return p && CARD_VALUE_ONLY.has(p.group) ? p.value : t;
};

/**
 * Search (title, ingredients, notes, tag values), tag and time filters and the sort run client-side
 * over the cached list, so they work offline. With a search, relevance comes first (title matches,
 * then tags and ingredients, then notes) and the chosen sort orders the recipes within each of those.
 * `bookmarks` (the /bookmarks page, switched by All / Saved above the cards) narrows the list to my bookmarks before all of that.
 */
export function RecipeList({ bookmarks = false }: { bookmarks?: boolean }) {
  const all = useSignal(summaries);
  const me = useSignal(currentUser);
  const cat = useSignal(catalogue);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // "duration" is a tab like the tag groups, holding the total-time filter
  const [openGroup, setOpenGroup] = useState<TagGroup | "duration" | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const list = useMemo(() => (bookmarks ? all?.filter((r) => r.bookmarks.some((b) => b.user === me)) : all), [all, bookmarks, me]);
  const [time, setTime] = useState<string | null>(null);
  const [cached, setCached] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadSummaries();
    void recentlyCached().then((ids) => setCached(new Set(ids)));
  }, []);

  const groups = useMemo(() => filterGroups((list ?? []).map((r) => r.tags)), [list]);
  // search and time first; the tag filter and the facet counts both work on top of these
  const searched = useMemo(() => searchRecipes(list ?? [], q, cat), [list, q, cat]);
  const base = useMemo(() => searched.filter((r) => matchesTimeFilter(r.time, time)), [searched, time]);
  const counts = useMemo(
    () =>
      facetCounts(
        base.map((r) => r.tags),
        selected,
      ),
    [base, selected],
  );
  // like a tag group: each duration counts what it would show with the other filters kept
  const timeCounts = useMemo(() => {
    const tagged = searched.filter((r) => matchesTagFilter(r.tags, selected));
    return new Map(TIME_FILTERS.map((f) => [f.id, tagged.filter((r) => matchesTimeFilter(r.time, f.id)).length]));
  }, [searched, selected]);
  const shown = useMemo(
    () => searchRecipes(base.filter((r) => matchesTagFilter(r.tags, selected)).sort(compareRecipes(sort)), q, cat),
    [base, q, selected, sort, cat],
  );
  const toggle = (t: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(t)) next.add(t);
      return next;
    });
  const open = groups.find((g) => g.group === openGroup);
  const arrow = <span aria-label={sort.dir === "asc" ? "ascending" : "descending"}>{sort.dir === "asc" ? " ↑" : " ↓"}</span>;

  return (
    <main className="page">
      <div className="toolbar">
        <input type="search" placeholder="Search title, ingredient, notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <Link href="/import" className="button">
          Import from link
        </Link>
        <Link href="/recipes/new" className="button">
          + New
        </Link>
      </div>
      <div className="chips tag-groups" role="toolbar" aria-label="Filter by duration or tag group">
        <button
          type="button"
          className={`chip group-tab${openGroup === "duration" ? " open" : ""}${time ? " on" : ""}`}
          data-group="duration"
          aria-expanded={openGroup === "duration"}
          aria-controls="tag-values"
          onClick={() => setOpenGroup(openGroup === "duration" ? null : "duration")}
        >
          <span className="tag-group" data-group="duration">
            duration
          </span>
          {time && <span className="small"> 1</span>}
        </button>
        {groups.map(({ group, tags }) => {
          const n = tags.filter((t) => selected.has(t.tag)).length;
          return (
            <button
              key={group}
              type="button"
              className={`chip group-tab${openGroup === group ? " open" : ""}${n ? " on" : ""}`}
              data-group={group}
              aria-expanded={openGroup === group}
              aria-controls="tag-values"
              onClick={() => setOpenGroup(openGroup === group ? null : group)}
            >
              <span className="tag-group" data-group={group}>
                {group}
              </span>
              {n > 0 && <span className="small"> {n}</span>}
            </button>
          );
        })}
      </div>
      {openGroup === "duration" && (
        <div id="tag-values" className="chips tray" data-group="duration" role="group" aria-label="Total time">
          {TIME_FILTERS.map((f) => {
            const on = time === f.id;
            const n = timeCounts.get(f.id) ?? 0;
            return (
              <button
                key={f.id}
                type="button"
                className={`chip tag-chip${on ? " on" : ""}${n === 0 && !on ? " empty" : ""}`}
                data-group="duration"
                aria-pressed={on}
                disabled={n === 0 && !on}
                onClick={() => setTime(on ? null : f.id)}
              >
                <span className="tag-value">{f.label}</span>
                <span className="muted small">{n}</span>
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <div id="tag-values" className="chips tray" data-group={open.group} role="group" aria-label={`${open.group} tags`}>
          {open.tags.map(({ tag }) => {
            const on = selected.has(tag);
            const n = counts.get(tag) ?? 0;
            return (
              <button
                key={tag}
                type="button"
                className={`chip tag-chip${on ? " on" : ""}${n === 0 && !on ? " empty" : ""}`}
                data-group={open.group}
                aria-pressed={on}
                disabled={n === 0 && !on}
                onClick={() => toggle(tag)}
              >
                <span className="tag-value">{parseTag(tag)?.value ?? tag}</span>
                <span className="muted small">{n}</span>
              </button>
            );
          })}
        </div>
      )}
      {(selected.size > 0 || time) && (
        <div className="chips" aria-label="Active filters">
          {time && (
            <span className="chip tag-chip on" data-group="duration">
              <span className="tag-group" data-group="duration">
                duration
              </span>
              <span className="tag-value">{TIME_FILTERS.find((f) => f.id === time)?.label}</span>
              <button type="button" aria-label="Remove duration filter" onClick={() => setTime(null)}>
                ×
              </button>
            </span>
          )}
          {[...selected].map((t) => (
            <TagChip key={t} tag={t} on onRemove={() => toggle(t)} />
          ))}
          <button
            type="button"
            className="link-button small"
            onClick={() => {
              setSelected(new Set());
              setTime(null);
            }}
          >
            clear
          </button>
        </div>
      )}
      <div className="list-bar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={!bookmarks} onClick={() => bookmarks && navigate("/", { replace: true })}>
            All
          </button>
          <button type="button" aria-pressed={bookmarks} onClick={() => !bookmarks && navigate("/bookmarks", { replace: true })}>
            <BookmarkIcon filled={bookmarks} />
            Saved
          </button>
        </div>
        <button type="button" className="link-button sort-toggle" aria-expanded={sortOpen} aria-controls="sort-options" onClick={() => setSortOpen(!sortOpen)}>
          Sort: <strong>{SORTS.find((o) => o.id === sort.id)!.label}</strong>
          {arrow}
        </button>
      </div>
      {sortOpen && (
        <div id="sort-options" className="chips sort-options" role="group" aria-label="Sort">
          {SORTS.map((o) => {
            const active = sort.id === o.id;
            return (
              <button
                key={o.id}
                type="button"
                className={active ? "chip on" : "chip"}
                aria-pressed={active}
                title={active ? "Click again to reverse" : undefined}
                onClick={() => setSort(nextSort(sort, o.id))}
              >
                {o.label}
                {active && arrow}
              </button>
            );
          })}
        </div>
      )}
      {list === undefined && <p className="muted">Loading...</p>}
      <ul className="recipe-list">
        {shown.map((r) => (
          <li key={r.id}>
            <Link href={`/recipes/${r.id}`}>
              {r.cover_key ? (
                <img
                  className="thumb"
                  src={coverUrl(r.cover_key)}
                  style={{ objectPosition: focusPosition(r.cover_focus) }}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span className="thumb placeholder" aria-hidden="true">
                  {r.title.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="card-body">
                <span className="title">{r.title}</span>
                <span className="meta">
                  <AvgStars avg={r.avg_rating} count={r.rating_count} />
                  {r.time && <span className="muted small">{formatMinutes(r.time.total_min)}</span>}
                  {r.yield && (
                    <span className="muted small">
                      {r.yield.amount} {r.yield.unit}
                    </span>
                  )}
                  {cached.has(r.id) && (
                    <span className="muted small" title="Available offline">
                      ⤓ offline
                    </span>
                  )}
                </span>
                <span className="tags small">{r.tags.map(cardTag).join(" · ")}</span>
                <span className="modified small">modified {ago(r.updated_at)}</span>
              </span>
            </Link>
            <BookmarkButton on={r.bookmarks.some((b) => b.user === me)} onToggle={() => void setBookmark(r.id, me, !r.bookmarks.some((b) => b.user === me))} />
          </li>
        ))}
      </ul>
      {list && shown.length === 0 && (
        <p className="muted">
          {bookmarks && list.length === 0 ? "Nothing bookmarked yet. Tap the bookmark on a recipe to keep it here." : "No recipes match."}
        </p>
      )}
    </main>
  );
}
