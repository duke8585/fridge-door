import { type ReactNode, useEffect, useMemo, useState } from "react";
import { coverUrl, focusPosition } from "../../shared/cover";
import { titleInitials } from "../../shared/coverArt";
import type { RecipeSummary } from "../../shared/schema";
import { searchRecipes } from "../../shared/search";
import { ARCHIVED_TAG, isArchived, parseTag, primaryCourse, type TagGroup } from "../../shared/tags";
import { formatMinutes, matchesTimeFilter, TIME_FILTERS } from "../../shared/time";
import { AiBadge } from "../components/AiBadge";
import { BookmarkButton, BookmarkIcon } from "../components/BookmarkButton";
import { AvgStars } from "../components/Stars";
import { TagChip } from "../components/TagChip";
import { ago } from "../lib/ago";
import { readFilter, writeFilter } from "../lib/listParams";
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

/** The list's last query string, so every way back to the list (links, not only Back) restores it until the app reloads. */
let remembered = "";

/**
 * Search (title, ingredients, notes, tag values), tag and time filters and the sort run client-side
 * over the cached list, so they work offline. With a search, relevance comes first (title matches,
 * then tags and ingredients, then notes) and the chosen sort orders the recipes within each of those.
 * `bookmarks` (the /bookmarks page, switched by All / Saved above the cards) narrows the list to my bookmarks before all of that.
 * Archived recipes (status:archived) are left out unless the Archived toggle is on; then they come after the others.
 */
export function RecipeList({ bookmarks = false }: { bookmarks?: boolean }) {
  const all = useSignal(summaries);
  const me = useSignal(currentUser);
  const cat = useSignal(catalogue);
  // Search, filters and sort live in the URL (?q= ?tag= ?time= ?sort=); a bare / or /bookmarks takes the remembered ones.
  const [initial] = useState(() => readFilter(location.search || remembered));
  const [q, setQ] = useState(initial.q);
  const [selected, setSelected] = useState<ReadonlySet<string>>(initial.tags);
  // "duration" is a tab like the tag groups, holding the total-time filter
  const [openGroup, setOpenGroup] = useState<TagGroup | "duration" | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [sort, setSort] = useState<Sort>(initial.sort);
  const [showArchived, setShowArchived] = useState(initial.archived);
  const list = useMemo(() => (bookmarks ? all?.filter((r) => r.bookmarks.some((b) => b.user === me)) : all), [all, bookmarks, me]);
  const archivedCount = useMemo(() => list?.filter((r) => isArchived(r.tags)).length ?? 0, [list]);
  // archived recipes are left out before anything else, so they neither show nor count in a chip unless the toggle is on
  const visible = useMemo(() => (showArchived ? list : list?.filter((r) => !isArchived(r.tags))), [list, showArchived]);
  const [time, setTime] = useState<string | null>(initial.time);
  const [cached, setCached] = useState<Set<string>>(new Set());

  useEffect(() => {
    const search = writeFilter(location.search, { q, tags: selected, time, sort, archived: showArchived });
    remembered = search;
    if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash);
  }, [q, selected, time, sort, showArchived]);

  useEffect(() => {
    void loadSummaries();
    void recentlyCached().then((ids) => setCached(new Set(ids)));
  }, []);

  const groups = useMemo(() => filterGroups((visible ?? []).map((r) => r.tags)), [visible]);
  // search and time first; the tag filter and the facet counts both work on top of these
  const searched = useMemo(() => searchRecipes(visible ?? [], q, cat), [visible, q, cat]);
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
  // archived ones after the rest, each part in the chosen order
  const [live, archived] = useMemo(() => [shown.filter((r) => !isArchived(r.tags)), shown.filter((r) => isArchived(r.tags))], [shown]);
  // with the toggle off, a search still says when it would find archived recipes
  const hiddenMatches = useMemo(() => {
    if (showArchived || !q.trim() || !list) return 0;
    const pool = list.filter((r) => isArchived(r.tags) && matchesTimeFilter(r.time, time) && matchesTagFilter(r.tags, selected));
    return searchRecipes(pool, q, cat).length;
  }, [showArchived, q, list, time, selected, cat]);
  const toggle = (t: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(t)) next.add(t);
      return next;
    });
  const open = groups.find((g) => g.group === openGroup);
  const card = (r: RecipeSummary): ReactNode => {
    const gone = isArchived(r.tags);
    return (
      <li key={r.id} className={gone ? "archived" : undefined}>
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
            <span className="thumb placeholder" data-course={primaryCourse(r.tags)} aria-hidden="true">
              {titleInitials(r.title)}
            </span>
          )}
          {gone ? <span className="archived-pill">archived</span> : r.cover_key && r.cover_ai && <AiBadge />}
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
            <span className="tags small">
              {r.tags
                .filter((t) => t !== ARCHIVED_TAG)
                .map(cardTag)
                .join(" · ")}
            </span>
            <span className="modified small">modified {ago(r.updated_at)}</span>
          </span>
        </Link>
        <BookmarkButton on={r.bookmarks.some((b) => b.user === me)} onToggle={() => void setBookmark(r.id, me, !r.bookmarks.some((b) => b.user === me))} />
      </li>
    );
  };
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
              setQ("");
              setSelected(new Set());
              setTime(null);
              setSort(DEFAULT_SORT);
            }}
          >
            clear
          </button>
        </div>
      )}
      <div className="list-bar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={!bookmarks} onClick={() => bookmarks && navigate(`/${location.search}`, { replace: true })}>
            All
          </button>
          <button type="button" aria-pressed={bookmarks} onClick={() => !bookmarks && navigate(`/bookmarks${location.search}`, { replace: true })}>
            <BookmarkIcon filled={bookmarks} />
            Saved
          </button>
        </div>
        {(archivedCount > 0 || showArchived) && (
          <button
            type="button"
            className="archived-toggle"
            aria-pressed={showArchived}
            title={showArchived ? "Hide archived recipes" : "Show archived recipes after the others"}
            onClick={() => setShowArchived(!showArchived)}
          >
            Archived <span className="small">{archivedCount}</span>
          </button>
        )}
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
        {live.map(card)}
        {archived.length > 0 && (
          <li className="list-divider" aria-hidden="true">
            Archived · {archived.length}
          </li>
        )}
        {archived.map(card)}
      </ul>
      {hiddenMatches > 0 && (
        <p className="muted small">
          {hiddenMatches === 1 ? "1 archived recipe matches" : `${hiddenMatches} archived recipes match`} ·{" "}
          <button type="button" className="link-button small" onClick={() => setShowArchived(true)}>
            show
          </button>
        </p>
      )}
      {list && shown.length === 0 && (
        <p className="muted">
          {bookmarks && list.length === 0 ? "Nothing bookmarked yet. Tap the bookmark on a recipe to keep it here." : "No recipes match."}
        </p>
      )}
    </main>
  );
}
