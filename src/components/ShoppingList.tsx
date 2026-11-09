import { newId } from "../lib/id";
import { useMemo, useState, type FormEvent } from "react";
import { parseIngredientLine } from "../../shared/parse";
import { formatQty } from "../../shared/scale";
import { groupShopping, nextTimestamp } from "../../shared/shopping";
import { useSignal } from "../lib/signal";
import { Link } from "../lib/router";
import { addShoppingItems, clearAll, clearChecked, removeItem, removeRecipe, setGroupChecked, shopping, toggleItem } from "../store/shopping";
import { useArmed } from "../lib/armed";
import { downloadText, shoppingToMarkdown } from "../lib/shoppingMarkdown";

export function useUncheckedCount(): number {
  const items = useSignal(shopping);
  return useMemo(() => [...items.values()].filter((i) => !i.deleted && !i.checked).length, [items]);
}

export function ShoppingList({ onNavigate }: { onNavigate?: () => void }) {
  const items = useSignal(shopping);
  const groups = useMemo(() => groupShopping(items.values()), [items]);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  // every word must appear in the item name (recipe titles are not searched)
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return groups;
    return groups.filter((g) => words.every((w) => g.label.toLowerCase().includes(w)));
  }, [groups, query]);
  const anyChecked = groups.some((g) => g.lines.some((l) => l.checked));
  const live = useMemo(() => [...items.values()].filter((i) => !i.deleted), [items]);
  // the recipes on the list, in the order they were added, with how many items each brought
  const recipes = useMemo(() => {
    const m = new Map<string, { title: string; n: number; first: string }>();
    for (const i of live) {
      if (!i.recipe_id) continue;
      const r = m.get(i.recipe_id);
      if (r) {
        r.n++;
        if (i.updated_at < r.first) r.first = i.updated_at;
      } else m.set(i.recipe_id, { title: i.recipe_title ?? "Recipe", n: 1, first: i.updated_at });
    }
    return [...m].sort((a, b) => (a[1].first < b[1].first ? -1 : 1));
  }, [live]);
  // shared list: removing a recipe or clearing everything also clears it on the other phone, so both take two taps
  const { armed, tap } = useArmed<string>();
  const ALL = "\u0000all";

  const add = (e: FormEvent): void => {
    e.preventDefault();
    const parsed = parseIngredientLine(text);
    if (!parsed) return;
    void addShoppingItems([
      {
        id: newId(),
        item: parsed.item,
        qty: parsed.qty,
        qtyMax: parsed.qtyMax,
        unit: parsed.unit,
        checked: false,
        updated_at: nextTimestamp(),
      },
    ]);
    setText("");
  };

  return (
    <div className="shopping">
      <form className="add-free" onSubmit={add}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add item, e.g. 2 l milk"
          enterKeyHint="done"
          aria-label="Add item"
        />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>

      {recipes.length > 0 && (
        <ul className="chips list-recipes" aria-label="Recipes on the list">
          {recipes.map(([id, r]) => (
            <li key={id} className={`chip${armed === id ? " armed" : ""}`}>
              <Link href={`/recipes/${id}`} onClick={onNavigate}>
                {r.title}
              </Link>
              <span className="muted small">{r.n}</span>
              <button
                type="button"
                aria-label={armed === id ? `Tap again to remove ${r.title} from the list` : `Remove ${r.title} from the list`}
                onClick={() => tap(id) && void removeRecipe(id)}
              >
                {armed === id ? "remove?" : "×"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {groups.length > 0 && (
        <input type="search" className="shopping-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the list" aria-label="Search the list" />
      )}

      {groups.length === 0 && <p className="muted center">The list is empty.</p>}
      {groups.length > 0 && shown.length === 0 && <p className="muted center">Nothing on the list matches.</p>}

      <ul className="groups">
        {shown.map((g) => {
          const showLines = g.lines.length > 1 || g.lines.some((l) => l.qty !== undefined || l.recipe_title);
          return (
            <li key={g.key} className={g.allChecked ? "group done" : "group"}>
              <label className="group-head">
                <input type="checkbox" checked={g.allChecked} onChange={() => void setGroupChecked(g.key, !g.allChecked)} />
                <span className="group-label">{g.label}</span>
                {!showLines && (
                  <button type="button" className="icon ghost" aria-label="Remove" onClick={() => void removeItem(g.lines[0]!.id)}>
                    ×
                  </button>
                )}
              </label>
              {showLines && (
                <ul className="lines">
                  {g.lines.map((l) => (
                    <li key={l.id} className={l.checked ? "line done" : "line"}>
                      <label>
                        <input type="checkbox" checked={l.checked} onChange={() => void toggleItem(l.id)} />
                        <span>
                          {formatQty(l.qty, l.qtyMax, l.unit) || "-"}
                          {l.recipe_title && (
                            <>
                              {" - "}
                              {l.recipe_id ? (
                                <Link href={`/recipes/${l.recipe_id}`} onClick={onNavigate}>
                                  {l.recipe_title}
                                </Link>
                              ) : (
                                l.recipe_title
                              )}
                            </>
                          )}
                        </span>
                      </label>
                      <button type="button" className="icon ghost" aria-label="Remove" onClick={() => void removeItem(l.id)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {live.length > 0 && (
        <div className="row gap clear-buttons">
          {anyChecked && (
            <button type="button" className="secondary" onClick={() => void clearChecked()}>
              Clear checked
            </button>
          )}
          <button type="button" className={armed === ALL ? "danger" : "secondary"} onClick={() => tap(ALL) && void clearAll()}>
            {armed === ALL ? `Tap again to clear ${live.length} items` : "Clear all"}
          </button>
        </div>
      )}
      {live.length > 0 && (
        <button
          type="button"
          className="link-button small"
          onClick={() => {
            const date = new Date().toISOString().slice(0, 10);
            downloadText(`shopping-list-${date}.md`, shoppingToMarkdown(groups, location.origin, date));
          }}
        >
          Download as markdown
        </button>
      )}
    </div>
  );
}
