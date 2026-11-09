import { newId } from "../lib/id";
import { useEffect, useMemo, useState } from "react";
import type { Comment, Ingredient, Recipe } from "../../shared/schema";
import { coverUrl, focusPosition } from "../../shared/cover";
import { formatTime } from "../../shared/time";
import { factorForYield, formatNumber, formatQty, scaleIngredient, spoonInMl } from "../../shared/scale";
import { ingredientsToShopping, nextTimestamp } from "../../shared/shopping";
import { Markdown, splitSteps } from "../components/Markdown";
import { recipeToText, shareText, type ShareResult } from "../lib/shareText";
import { StarsInput } from "../components/Stars";
import { TagInput, type TagValue } from "../components/TagInput";
import { Link } from "../lib/router";
import { MAX_FACTOR, parseFactor, readScale, writeScale } from "../lib/scaleParams";
import { useSignal } from "../lib/signal";
import { currentUser } from "../lib/user";
import { loginHref } from "../lib/api";
import { addTag, deleteComment, detailSignal, loadRecipe, putComment, rate, removeTag, type LoadError } from "../store/recipes";
import { addShoppingItems } from "../store/shopping";
import { openRecipes } from "../store/sync";

function useWakeLock(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let cancelled = false;
    const acquire = async (): Promise<void> => {
      try {
        lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release();
        else {
          setHeld(true);
          lock.addEventListener("release", () => setHeld(false));
        }
      } catch {
        setHeld(false);
      }
    };
    // The lock is dropped when the tab is hidden; take it again on return.
    const onVis = (): void => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release();
    };
  }, [enabled]);
  return held;
}

export function RecipeView({ id }: { id: string }) {
  const sig = detailSignal(id);
  const state = useSignal(sig);

  useEffect(() => {
    openRecipes.add(id);
    void loadRecipe(id);
    return () => {
      openRecipes.delete(id);
    };
  }, [id]);

  if (state.missing) return <main className="page"><p>Recipe not found. <Link href="/">Back</Link></p></main>;
  if (!state.detail && state.error) return <main className="page"><LoadErrorNotice error={state.error} cached={false} /></main>;
  if (!state.detail) return <main className="page"><p className="muted">Loading...</p></main>;
  return (
    <>
      {state.error && (
        <div className="page notice-wrap">
          <LoadErrorNotice error={state.error} cached />
        </div>
      )}
      <RecipeBody recipe={state.detail.recipe} comments={state.detail.comments} />
    </>
  );
}

/** Offline, logged out and server failure read differently, so a 500 is never blamed on the network. */
export function LoadErrorNotice({ error, cached }: { error: LoadError; cached: boolean }) {
  const saved = cached ? " Showing the copy saved on this device." : "";
  switch (error.kind) {
    case "offline":
      return <p className="notice">{cached ? "You are offline." + saved : "You are offline and this recipe was never opened on this device."}</p>;
    case "auth":
      return (
        <p className="notice">
          Your login has expired. <a href={loginHref()}>Log in again</a>.{saved}
        </p>
      );
    case "server":
      return (
        <p className="notice error" role="alert">
          The server had a problem loading this recipe{error.status ? ` (${error.status})` : ""}: {error.message}. Try again in a moment.{saved}
        </p>
      );
  }
}

function RecipeBody({ recipe, comments }: { recipe: Recipe; comments: Comment[] }) {
  const user = useSignal(currentUser);
  const [cooking, setCooking] = useState(false);
  const wake = useWakeLock(cooking);
  // Scale lives in the URL (?servings= / ?factor=) so reload, back/forward and shared links keep it.
  const [initial] = useState(() => readScale(location.search, recipe.yield?.amount));
  const [servings, setServings] = useState(initial.servings);
  const [factor, setFactor] = useState(initial.factor);
  useEffect(() => {
    const search = writeScale(location.search, { servings, factor }, recipe.yield?.amount);
    if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash);
  }, [servings, factor, recipe.yield?.amount]);
  const [crossed, setCrossed] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<string>();
  const [fullCover, setFullCover] = useState(false);

  const f = recipe.yield ? factorForYield(recipe.yield.amount, servings) : factor;
  const scaled = useMemo(
    () => recipe.sections.map((s) => ({ ...s, ingredients: s.ingredients.map((i) => scaleIngredient(i, f)) })),
    [recipe.sections, f],
  );
  const steps = useMemo(() => splitSteps(recipe.steps_md), [recipe.steps_md]);
  const mine = recipe.ratings.find((r) => r.user === user)?.stars;
  // Imported stubs have no ingredients and/or no steps yet: show what exists and point at the source.
  const hasIngredients = recipe.sections.some((s) => s.ingredients.length > 0);
  const hasSteps = recipe.steps_md.trim() !== "";

  const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  const addToList = async (): Promise<void> => {
    const now = nextTimestamp();
    const rows = ingredientsToShopping(scaled.flatMap((s) => s.ingredients), recipe, () => newId(), now);
    await addShoppingItems(rows);
    setToast(`Added ${rows.length} items${f !== 1 ? ` (x${formatNumber(f)})` : ""}`);
    setTimeout(() => setToast(undefined), 2500);
  };

  return (
    <main className={cooking ? "page recipe cooking" : "page recipe"}>
      <div className="recipe-head">
        {recipe.cover_key && !cooking && (
          <button type="button" className="cover-button" onClick={() => setFullCover(true)} aria-label="Show the full cover image">
            <img className="cover" src={coverUrl(recipe.cover_key)} style={{ objectPosition: focusPosition(recipe.cover_focus) }} alt="" decoding="async" />
          </button>
        )}
        {recipe.cover_key && fullCover && <Lightbox src={coverUrl(recipe.cover_key)} onClose={() => setFullCover(false)} />}
        <h1>{recipe.title}</h1>
        {recipe.time && <p className="muted time">{formatTime(recipe.time)}</p>}
        <div className="row wrap gap">
          {(hasIngredients || hasSteps) && (
            <button type="button" className={cooking ? "primary" : "secondary"} onClick={() => setCooking(!cooking)}>
              {cooking ? "Exit cooking mode" : "Cooking mode"}
            </button>
          )}
          {cooking && <span className="muted small">{wake ? "Screen stays on" : "Wake lock unavailable"}</span>}
          {!cooking && (
            <>
              <Link className="button secondary" href={`/recipes/${recipe.id}/edit`}>
                Edit
              </Link>
              <Link className="button secondary" href={`/recipes/${recipe.id}/history`}>
                History
              </Link>
              <ShareButton recipe={recipe} factor={f} />
            </>
          )}
        </div>
      </div>

      {!hasSteps && (
        <section className="stub">
          <p>Not written up yet - see source.</p>
          {recipe.source_url && (
            <a className="button primary" href={recipe.source_url} target="_blank" rel="noreferrer">
              Open source ({hostname(recipe.source_url)})
            </a>
          )}
        </section>
      )}

      {hasIngredients && (
        <>
          <section className="scale">
            {recipe.yield ? (
              <div className="stepper" aria-label="Servings">
                <button type="button" onClick={() => setServings(Math.max(1, servings - 1))} aria-label="Fewer">
                  −
                </button>
                <span>
                  <b>{servings}</b> {recipe.yield.unit}
                </span>
                <button type="button" onClick={() => setServings(servings + 1)} aria-label="More">
                  +
                </button>
              </div>
            ) : (
              <div className="factor" aria-label="Scale factor">
                {[0.5, 1, 2].map((x) => (
                  <button key={x} type="button" className={factor === x ? "chip on" : "chip"} onClick={() => setFactor(x)}>
                    x{formatNumber(x)}
                  </button>
                ))}
                <FactorInput factor={factor} onFactor={setFactor} />
              </div>
            )}
          </section>

          <section className="ingredients">
            {scaled.map((s, si) => (
              <div key={si}>
                {s.title && <h3>{s.title}</h3>}
                <ul>
                  {s.ingredients.map((ing, ii) => {
                    const key = `${si}.${ii}`;
                    return (
                      <li key={key} className={crossed.has(key) ? "crossed" : ""} onClick={cooking ? () => setCrossed(toggle(crossed, key)) : undefined}>
                        <IngredientLine ing={ing} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            <button type="button" className="primary wide" onClick={() => void addToList()}>
              Add to shopping list
            </button>
            {toast && <p className="toast">{toast}</p>}
          </section>
        </>
      )}

      {hasSteps && (
        <section className="steps">
          <h2>Steps</h2>
          {cooking ? (
            <ol className="step-list">
              {steps.map((s, i) => (
                <li key={i} className={done.has(i) ? "done" : ""} onClick={() => setDone(toggle(done, i))}>
                  <Markdown src={s} inline />
                </li>
              ))}
            </ol>
          ) : (
            <Markdown src={recipe.steps_md} />
          )}
        </section>
      )}

      {recipe.notes_md && (
        <section className="notes">
          <h2>Notes</h2>
          <Markdown src={recipe.notes_md} />
        </section>
      )}

      {!cooking && (
        <>
          {recipe.source_url && hasSteps && (
            <p className="small">
              Source:{" "}
              <a href={recipe.source_url} target="_blank" rel="noreferrer">
                {hostname(recipe.source_url)}
              </a>
            </p>
          )}
          <section className="rating">
            <h2>Rating</h2>
            <div className="row gap wrap">
              <span>{user}:</span>
              <StarsInput value={mine} onChange={(s) => void rate(recipe.id, user, s)} />
              {recipe.ratings
                .filter((r) => r.user !== user)
                .map((r) => (
                  <span key={r.user} className="muted small">
                    {r.user}: {"★".repeat(r.stars)}
                  </span>
                ))}
            </div>
          </section>
          <TagEditor recipe={recipe} />
          <Comments recipeId={recipe.id} comments={comments} />
        </>
      )}
    </main>
  );
}

/** The whole image, uncropped. Tap anywhere or press Escape to close. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Cover image" onClick={onClose}>
      <img src={src} alt="" />
      <button type="button" className="close" aria-label="Close" autoFocus>
        ×
      </button>
    </div>
  );
}

const hostname = (url: string): string => new URL(url).hostname.replace(/^www\./, "");

/** Shares the recipe as plain text at the amounts on screen; says "Copied" where it used the clipboard. */
function ShareButton({ recipe, factor }: { recipe: Recipe; factor: number }) {
  const [result, setResult] = useState<ShareResult | null>(null);
  useEffect(() => {
    if (result === null) return;
    const t = setTimeout(() => setResult(null), 2500);
    return () => clearTimeout(t);
  }, [result]);
  return (
    <>
      <button type="button" className="secondary" onClick={() => void shareText(recipeToText(recipe, factor, `${location.origin}/recipes/${recipe.id}`)).then(setResult)}>
        Share
      </button>
      {result === "copied" && <span className="muted small" role="status">Copied</span>}
      {result === "failed" && <span className="error small" role="status">Could not share or copy</span>}
    </>
  );
}

/**
 * Custom factor as a text field holding its own string, so typing "0," or "1 1/" does not snap
 * back. Accepts "0,75", "3/4", "1 1/2", "½". Applied only when it parses to a value > 0.
 */
function FactorInput({ factor, onFactor }: { factor: number; onFactor: (f: number) => void }) {
  const [text, setText] = useState(String(factor));
  // A chip click changes the factor from outside: show it unless the text already means that value.
  useEffect(() => setText((t) => (parseFactor(t) === factor ? t : String(factor))), [factor]);
  const invalid = parseFactor(text) === undefined;
  return (
    <label className="custom">
      x
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label="Custom scale factor"
        aria-invalid={invalid || undefined}
        title={invalid ? `Enter a number like 1.5, 0,75, 3/4 or 1 1/2 (up to ${MAX_FACTOR})` : undefined}
        className={invalid ? "invalid" : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseFactor(e.target.value);
          if (n !== undefined) onFactor(n);
        }}
        onBlur={() => {
          if (parseFactor(text) === undefined) setText(String(factor));
        }}
      />
    </label>
  );
}

function IngredientLine({ ing }: { ing: Ingredient }) {
  const [showMl, setShowMl] = useState(false);
  const qty = formatQty(ing.qty, ing.qtyMax, ing.unit);
  const ml = spoonInMl(ing.qty, ing.qtyMax, ing.unit);
  return (
    <span className="ing">
      {qty && (
        <b className="qty">
          {ml ? (
            <button
              type="button"
              className="spoon"
              title={ml}
              onClick={(e) => {
                e.stopPropagation();
                setShowMl(!showMl);
              }}
            >
              {qty}
              {showMl && <span className="ml"> ({ml})</span>}
            </button>
          ) : (
            qty
          )}
        </b>
      )}
      {qty && " "}
      <span className="item">{ing.item}</span>
      {ing.prep && <span className="prep">, {ing.prep}</span>}
      {ing.note && <span className="note"> ({ing.note})</span>}
    </span>
  );
}

/**
 * The same combobox as the editor. Each change is saved as an add/remove delta (outbox op), so it
 * works offline and merges with the other person's edits.
 */
function TagEditor({ recipe }: { recipe: Recipe }) {
  const user = useSignal(currentUser);
  const [text, setText] = useState("");
  const onChange = ({ tags, text: nextText }: TagValue): void => {
    for (const t of tags) if (!recipe.tags.includes(t)) void addTag(recipe.id, user, t);
    for (const t of recipe.tags) if (!tags.includes(t)) void removeTag(recipe.id, user, t);
    setText(nextText);
  };
  return (
    <section className="tags-edit">
      <h2>Tags</h2>
      <TagInput value={{ tags: recipe.tags, text }} onChange={onChange} label="Add or remove tags" />
    </section>
  );
}

function Comments({ recipeId, comments }: { recipeId: string; comments: Comment[] }) {
  const user = useSignal(currentUser);
  const [editing, setEditing] = useState<string>();
  return (
    <section className="comments">
      <h2>Comments</h2>
      {comments.length === 0 && <p className="muted small">No comments yet.</p>}
      <ul>
        {comments.map((c) => (
          <li key={c.id}>
            <div className="comment-meta small">
              <b>{c.user}</b> <span className="muted">{new Date(c.created_at).toLocaleDateString()}</span>
              {c.user === user && editing !== c.id && (
                <>
                  <button type="button" className="link" onClick={() => setEditing(c.id)}>
                    edit
                  </button>
                  <button type="button" className="link danger" onClick={() => void deleteComment(recipeId, user, c.id)}>
                    delete
                  </button>
                </>
              )}
            </div>
            {editing === c.id ? (
              <CommentForm
                initial={c.body_md}
                submitLabel="Save"
                onCancel={() => setEditing(undefined)}
                onSubmit={(body) => {
                  void putComment(recipeId, user, body, c);
                  setEditing(undefined);
                }}
              />
            ) : (
              <Markdown src={c.body_md} />
            )}
          </li>
        ))}
      </ul>
      <CommentForm submitLabel="Comment" onSubmit={(body) => void putComment(recipeId, user, body)} />
    </section>
  );
}

function CommentForm(props: { initial?: string; submitLabel: string; onSubmit: (body: string) => void; onCancel?: () => void }) {
  const [body, setBody] = useState(props.initial ?? "");
  const [preview, setPreview] = useState(false);
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        props.onSubmit(body.trim());
        setBody("");
        setPreview(false);
      }}
    >
      {preview ? <div className="preview"><Markdown src={body || "_nothing to preview_"} /></div> : (
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Markdown supported" />
      )}
      <div className="row gap">
        <button type="submit" className="primary" disabled={!body.trim()}>
          {props.submitLabel}
        </button>
        <button type="button" className="secondary" onClick={() => setPreview(!preview)}>
          {preview ? "Write" : "Preview"}
        </button>
        {props.onCancel && (
          <button type="button" className="link" onClick={props.onCancel}>
            cancel
          </button>
        )}
      </div>
    </form>
  );
}
