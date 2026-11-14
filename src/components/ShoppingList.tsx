import { type FormEvent, useMemo, useState } from "react";
import { AISLES, aisleLabel, completeAisleOrder, isAisle, resolveLocal, singularKey } from "../../shared/catalogue";
import { parseIngredientLine } from "../../shared/parse";
import { formatQty } from "../../shared/scale";
import { byAisle, groupShopping, nextTimestamp } from "../../shared/shopping";
import { useArmed } from "../lib/armed";
import { newId } from "../lib/id";
import { Link } from "../lib/router";
import { downloadText, shoppingToMarkdown } from "../lib/shoppingMarkdown";
import { useSignal } from "../lib/signal";
import { aisleOrder, setAisleOrder } from "../store/aisles";
import { catalogue } from "../store/catalogue";
import { addShoppingItems, clearAll, clearChecked, moveToAisle, removeItem, removeRecipe, setGroupChecked, shopping, toggleItem } from "../store/shopping";

export function useUncheckedCount(): number {
  const items = useSignal(shopping);
  return useMemo(() => [...items.values()].filter((i) => !i.deleted && !i.checked).length, [items]);
}

export function ShoppingList({ onNavigate }: { onNavigate?: () => void }) {
  const items = useSignal(shopping);
  const cat = useSignal(catalogue);
  const order = useSignal(aisleOrder);
  const groups = useMemo(() => groupShopping(items.values(), cat), [items, cat]);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [editingOrder, setEditingOrder] = useState(false);
  // every word must appear in the base or an item name (recipe titles are not searched)
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching =
      words.length === 0 ? groups : groups.filter((g) => words.every((w) => [g.key, ...g.lines.map((l) => l.item)].some((n) => n.toLowerCase().includes(w))));
    return byAisle(matching, order?.order);
  }, [groups, query, order]);
  const sections = useMemo(() => byAisle(groups, order?.order), [groups, order]);
  const aisles = completeAisleOrder(order?.order);
  const moveAisle = (i: number, by: -1 | 1): void => {
    const next = [...aisles];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    void setAisleOrder(next);
  };
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
    // a name the local catalogue knows gets its base and aisle now; the server resolves the rest
    const known = resolveLocal(cat, parsed.item);
    void addShoppingItems([
      {
        id: newId(),
        item: parsed.item,
        ...(known.how !== "unknown" && { base: known.base, aisle: known.aisle }),
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add item, e.g. 2 l milk" enterKeyHint="done" aria-label="Add item" />
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
        <div className="shopping-search">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the list" aria-label="Search the list" />
        </div>
      )}

      {groups.length === 0 && <p className="muted center">The list is empty.</p>}
      {groups.length > 0 && shown.length === 0 && <p className="muted center">Nothing on the list matches.</p>}

      <ul className="aisles">
        {shown.map((section) => (
          <li key={section.aisle} className="aisle" data-aisle={section.aisle}>
            <h2 className="aisle-head">{aisleLabel(section.aisle)}</h2>
            <ul className="groups">
              {section.groups.map((g) => {
                const differs = (item: string): boolean => singularKey(item) !== g.key;
                const showLines = g.lines.length > 1 || g.lines.some((l) => l.qty !== undefined || l.recipe_title || differs(l.item));
                return (
                  <li key={g.key} className={g.allChecked ? "group done" : "group"}>
                    <label className="group-head">
                      <input type="checkbox" checked={g.allChecked} onChange={() => void setGroupChecked(g.key, !g.allChecked)} />
                      <span className="group-label">{g.key}</span>
                      <button
                        type="button"
                        className="icon ghost small"
                        aria-label={`Change the category of ${g.key}`}
                        aria-expanded={moving === g.key}
                        onClick={() => setMoving(moving === g.key ? null : g.key)}
                      >
                        change category
                      </button>
                      {!showLines && (
                        <button type="button" className="icon ghost" aria-label="Remove" onClick={() => void removeItem(g.lines[0]!.id)}>
                          ×
                        </button>
                      )}
                    </label>
                    {moving === g.key && (
                      <>
                        <select
                          className="aisle-select"
                          aria-label={`Category for ${g.key}, remembered for next time`}
                          value={g.aisle}
                          autoFocus
                          onChange={(e) => {
                            if (isAisle(e.target.value)) void moveToAisle(g.key, e.target.value);
                            setMoving(null);
                          }}
                        >
                          {AISLES.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                        <p className="aisle-hint">Saved for both of you: {g.key} goes here from now on, from every recipe.</p>
                      </>
                    )}
                    {showLines && (
                      <ul className="lines">
                        {g.lines.map((l) => {
                          const amount = [formatQty(l.qty, l.qtyMax, l.unit), differs(l.item) ? l.item : ""].filter(Boolean).join(" ");
                          return (
                            <li key={l.id} className={l.checked ? "line done" : "line"}>
                              <label>
                                <input type="checkbox" checked={l.checked} onChange={() => void toggleItem(l.id)} />
                                <span>
                                  {amount || <em className="muted">undefined</em>}
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
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
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
            downloadText(`shopping-list-${date}.md`, shoppingToMarkdown(sections, location.origin, date));
          }}
        >
          Download as markdown
        </button>
      )}
      <button type="button" className="link-button small" aria-expanded={editingOrder} onClick={() => setEditingOrder(!editingOrder)}>
        {editingOrder ? "Done ordering categories" : "Category order"}
      </button>
      {editingOrder && (
        <ol className="aisle-order" aria-label="Category order, shared by both of you">
          {aisles.map((a, i) => (
            <li key={a}>
              <span>{aisleLabel(a)}</span>
              <button type="button" className="icon ghost" aria-label={`Move ${aisleLabel(a)} up`} disabled={i === 0} onClick={() => moveAisle(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="icon ghost"
                aria-label={`Move ${aisleLabel(a)} down`}
                disabled={i === aisles.length - 1}
                onClick={() => moveAisle(i, 1)}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
