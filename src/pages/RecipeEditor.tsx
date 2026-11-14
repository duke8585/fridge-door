import { type ClipboardEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { METRIC_UNITS } from "../../shared/constants";
import { COVER_TYPES, coverFileProblem, coverUrl, DEFAULT_FOCUS, focusPosition, pointToFocus } from "../../shared/cover";
import type { DuplicateCandidate } from "../../shared/duplicates";
import { parseIngredientBlock, parseIngredientLine, parseNumber } from "../../shared/parse";
import type { CoverFocus, FieldErrors, Ingredient, Recipe, RecipeDetail, RecipeInput } from "../../shared/schema";
import { AI_UNAVAILABLE_TEXT, type UrlImportError, type UrlImportSaved } from "../../shared/urlImport";
import { Markdown } from "../components/Markdown";
import { TagInput } from "../components/TagInput";
import { ApiError, AuthError, api, NetworkError } from "../lib/api";
import {
  type DraftSection,
  deleteEmptyRow,
  emptyRow,
  FIELDS,
  type Field,
  isEmptyRow,
  moveRow as moveRowIn,
  newKey,
  type Row,
  rowFromIngredient,
  smartSplitRow,
} from "../lib/editorRows";
import { Link, navigate } from "../lib/router";
import { useSignal } from "../lib/signal";
import { addTag } from "../lib/tagInput";
import { currentUser } from "../lib/user";
import { dropImport, type PendingImport, takeImport } from "../store/importDraft";
import { detailSignal, loadRecipe, replaceRecipe, setBookmark, setCoverFocus } from "../store/recipes";
import { LoadErrorNotice } from "./RecipeView";

// ---------- draft model (strings while typing, converted on save) ----------
type Draft = {
  title: string;
  yieldAmount: string;
  yieldUnit: string;
  timeTotal: string;
  timeActive: string;
  tags: string[];
  /** Typed into the tag input but not picked yet; saved too, so a typed tag is never lost. */
  tagText: string;
  source_url: string;
  steps_md: string;
  notes_md: string;
  sections: DraftSection[];
};
const k = newKey;

function draftFromRecipe(r?: RecipeInput): Draft {
  return {
    title: r?.title ?? "",
    yieldAmount: r?.yield?.amount.toString() ?? "",
    yieldUnit: r?.yield?.unit ?? "",
    timeTotal: r?.time?.total_min.toString() ?? "",
    timeActive: r?.time?.active_min?.toString() ?? "",
    tags: r?.tags ?? [],
    tagText: "",
    source_url: r?.source_url ?? "",
    steps_md: r?.steps_md ?? "",
    notes_md: r?.notes_md ?? "",
    sections: r
      ? r.sections.map((s) => ({ key: k(), title: s.title ?? "", rows: [...s.ingredients.map(rowFromIngredient), emptyRow()] }))
      : [{ key: k(), title: "", rows: [emptyRow()] }],
  };
}

const opt = (s: string): string | undefined => (s.trim() === "" ? undefined : s.trim());
/** Unparseable numbers become null so the server's zod error points at the field. */
const num = (s: string): number | null | undefined => (s.trim() === "" ? undefined : (parseNumber(s) ?? null));

/** Build the request body (deliberately unvalidated: the server is the judge). Empty rows are skipped. */
function toBody(d: Draft): unknown {
  const amount = num(d.yieldAmount);
  const total = num(d.timeTotal);
  const active = num(d.timeActive);
  return {
    title: d.title,
    yield: amount === undefined && !opt(d.yieldUnit) ? undefined : { amount, unit: d.yieldUnit },
    time: total === undefined && active === undefined ? undefined : { total_min: total, active_min: active },
    tags: addTag(d.tags, d.tagText),
    source_url: opt(d.source_url),
    steps_md: d.steps_md,
    notes_md: d.notes_md,
    sections: d.sections.map((s) => ({
      title: opt(s.title),
      ingredients: s.rows
        .filter((r) => !isEmptyRow(r))
        .map((r) => ({
          item: r.item,
          qty: num(r.qty),
          qtyMax: num(r.qtyMax),
          unit: opt(r.unit),
          prep: opt(r.prep),
          note: opt(r.note),
        })),
    })),
  };
}

/** Server path prefix ("sections.1.ingredients.3") for each visible row, matching toBody's skipping. */
function rowPaths(d: Draft): Map<string, string> {
  const m = new Map<string, string>();
  d.sections.forEach((s, si) => {
    let j = 0;
    for (const r of s.rows) if (!isEmptyRow(r)) m.set(r.key, `sections.${si}.ingredients.${j++}`);
  });
  return m;
}

// ---------- page ----------
export function RecipeEditor({ id, importToken }: { id?: string; importToken?: string }) {
  const state = useSignal(detailSignal(id ?? "__new__"));
  const [imported] = useState(() => (importToken ? takeImport(importToken) : undefined));
  const [draft, setDraft] = useState<Draft | undefined>(id ? undefined : draftFromRecipe(imported?.draft.recipe));

  useEffect(() => {
    if (id) void loadRecipe(id);
  }, [id]);
  useEffect(() => {
    if (id && !draft && state.detail) setDraft(draftFromRecipe(state.detail.recipe));
  }, [id, draft, state.detail]);

  if (importToken && !imported) {
    return (
      <main className="page">
        <p className="notice">
          This import draft is no longer here (it lives only in the tab that started it). <Link href="/import">Import the link again</Link>.
        </p>
      </main>
    );
  }
  if (!draft) return <main className="page">{state.error ? <LoadErrorNotice error={state.error} cached={false} /> : <p className="muted">Loading...</p>}</main>;
  return (
    <EditorForm
      id={id}
      draft={draft}
      setDraft={(fn) => setDraft((d) => (d ? fn(d) : d))}
      existing={state.detail}
      imported={importToken && imported ? { token: importToken, pending: imported } : undefined}
    />
  );
}

function EditorForm({
  id,
  draft,
  setDraft,
  existing,
  imported,
}: {
  id?: string;
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
  existing?: RecipeDetail;
  imported?: { token: string; pending: PendingImport };
}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  /** A replacement cover picked or pasted in this session. Uploaded on Save, dropped on Cancel. */
  const [cover, setCover] = useState<File>();
  const [importState, setImportState] = useState(() =>
    imported
      ? {
          problems: imported.pending.draft.problems,
          duplicates: imported.pending.draft.duplicates,
          coverUrl: imported.pending.draft.cover_url,
          confirmDuplicate: imported.pending.forced,
        }
      : undefined,
  );
  const user = useSignal(currentUser);
  // an imported recipe is usually one you want to find again
  const [bookmarkIt, setBookmarkIt] = useState(true);
  const inputs = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string>();

  useEffect(() => {
    if (!focusKey) return;
    inputs.current.get(focusKey)?.focus();
    setFocusKey(undefined);
  }, [focusKey, draft]);

  const reg = (key: string) => (el: HTMLElement | null) => {
    if (el) inputs.current.set(key, el);
    else inputs.current.delete(key);
  };
  const paths = rowPaths(draft);
  const err = (path: string): string | undefined => errors[path];
  const tagError = Object.entries(errors).find(([p]) => p.startsWith("tags."));

  const set = <K extends keyof Draft>(field: K, value: Draft[K]): void => setDraft((d) => ({ ...d, [field]: value }));
  const updateSection = (si: number, fn: (s: DraftSection) => DraftSection): void =>
    setDraft((d) => ({ ...d, sections: d.sections.map((s, i) => (i === si ? fn(s) : s)) }));
  const updateRow = (si: number, ri: number, field: Field, value: string): void =>
    updateSection(si, (s) => ({ ...s, rows: s.rows.map((r, i) => (i === ri ? { ...r, [field]: value } : r)) }));

  const insertRows = (si: number, at: number, rows: Row[], replaceCurrent: boolean): void => {
    updateSection(si, (s) => {
      const next = [...s.rows];
      next.splice(at, replaceCurrent ? 1 : 0, ...rows);
      return { ...s, rows: next };
    });
  };

  const addRowAfter = (si: number, ri: number): void => {
    const row = emptyRow();
    insertRows(si, ri + 1, [row], false);
    setFocusKey(`${row.key}:qty`);
  };

  const removeRow = (si: number, ri: number): void =>
    updateSection(si, (s) => ({ ...s, rows: s.rows.length > 1 ? s.rows.filter((_, i) => i !== ri) : [emptyRow()] }));

  /** Move within a section; at the edge, hop into the neighbouring section. */
  const moveRow = (si: number, ri: number, dir: -1 | 1): void =>
    setDraft((d) => {
      const moved = moveRowIn(d.sections, { si, ri }, dir);
      return moved ? { ...d, sections: moved.sections } : d;
    });

  /** "200 g flour, sifted" typed into Item of a row without qty -> split into fields. */
  const smartSplit = (si: number, ri: number): void =>
    updateSection(si, (s) => ({ ...s, rows: s.rows.map((r, i) => (i === ri ? (smartSplitRow(r) ?? r) : r)) }));

  const moveSection = (si: number, dir: -1 | 1): void =>
    setDraft((d) => {
      const t = si + dir;
      if (t < 0 || t >= d.sections.length) return d;
      const sections = [...d.sections];
      [sections[si], sections[t]] = [sections[t]!, sections[si]!];
      return { ...d, sections };
    });

  /**
   * Row keyboard: Enter inserts a row below (splitting a whole line typed into Item first),
   * Backspace in a fully empty row deletes it and focuses the previous row,
   * Alt+ArrowUp/Down moves the row (across sections at the edges) and keeps focus on it.
   */
  const onRowKey = (si: number, ri: number, field: Field) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;
    const row = draft.sections[si]?.rows[ri];
    if (!row) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (field === "item") smartSplit(si, ri);
      addRowAfter(si, ri);
    } else if (e.key === "Backspace" && !e.altKey && !e.metaKey && !e.ctrlKey && isEmptyRow(row)) {
      const res = deleteEmptyRow(draft.sections, { si, ri });
      if (!res) return;
      e.preventDefault();
      setDraft((d) => ({ ...d, sections: res.sections }));
      if (res.focus) setFocusKey(`${res.focus}:${field}`);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveRow(si, ri, e.key === "ArrowUp" ? -1 : 1);
      setFocusKey(`${row.key}:${field}`); // the node may remount in another section
    }
  };

  /** Paste several lines into an item field -> parsed rows (and sections for "For the sauce:" lines). */
  const onItemPaste = (si: number, ri: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/\r?\n/.test(text.trim())) return;
    e.preventDefault();
    const parsed = parseIngredientBlock(text);
    if (parsed.length === 0) return;
    const current = draft.sections[si]!.rows[ri]!;
    const [first, ...more] = parsed;
    const firstRows = first!.ingredients.map(rowFromIngredient);
    setDraft((d) => {
      const sections = [...d.sections];
      const sec = { ...sections[si]!, rows: [...sections[si]!.rows] };
      sec.rows.splice(ri, isEmptyRow(current) ? 1 : 0, ...firstRows);
      if (first!.title && !sec.title) sec.title = first!.title;
      if (sec.rows.length === 0) sec.rows.push(emptyRow());
      sections[si] = sec;
      sections.splice(si + 1, 0, ...more.map((s) => ({ key: k(), title: s.title ?? "", rows: [...s.ingredients.map(rowFromIngredient), emptyRow()] })));
      return { ...d, sections };
    });
  };

  /** The import save path: same ingest as MCP (style-guide lint, duplicate guard, "Import notes:" comment). */
  const saveImport = async (confirmDuplicate: boolean): Promise<void> => {
    if (!imported || !importState) return;
    const saved = await api<UrlImportSaved>("/import-url/save", {
      method: "POST",
      json: { recipe: toBody(draft), review_notes: imported.pending.draft.review_notes, confirm_duplicate: confirmDuplicate, cover_url: importState.coverUrl },
      signal: AbortSignal.timeout(60_000),
    });
    setErrors({});
    await replaceRecipe({ recipe: saved.recipe, comments: saved.comments });
    dropImport(imported.token);
    if (bookmarkIt) await setBookmark(saved.recipe.id, user, true);
    if (saved.cover_error) alert(`The recipe was saved, but the cover could not be downloaded: ${saved.cover_error}`);
    navigate(`/recipes/${saved.recipe.id}`, { replace: true });
  };

  const save = async (confirmDuplicate = importState?.confirmDuplicate ?? false): Promise<void> => {
    setSaving(true);
    setMessage(undefined);
    try {
      if (imported) return await saveImport(confirmDuplicate);
      const body = toBody(draft);
      const recipe = id
        ? await api<Recipe>(`/recipes/${encodeURIComponent(id)}`, { method: "PUT", json: body })
        : await api<Recipe>("/recipes", { method: "POST", json: body });
      setErrors({});
      await replaceRecipe({ recipe, comments: existing?.comments ?? [] });
      if (cover) {
        try {
          await replaceRecipe({ recipe: await uploadCover(recipe.id, cover), comments: existing?.comments ?? [] });
        } catch (e) {
          const why = e instanceof NetworkError ? "you are offline" : e instanceof Error ? e.message : String(e);
          setMessage(`The recipe was saved, but the new cover was not uploaded (${why}). It is still staged: press Save to try again.`);
          return;
        }
      }
      navigate(`/recipes/${recipe.id}`, { replace: !id });
    } catch (e) {
      const importError = imported && e instanceof ApiError ? (e.body as UrlImportError | undefined) : undefined;
      if (importError?.error === "problems") {
        setImportState((s) => s && { ...s, problems: importError.problems });
        setMessage(`Not saved: ${importError.problems.length} style problem(s), listed at the top.`);
        window.scrollTo(0, 0);
      } else if (importError?.error === "duplicate") {
        setImportState((s) => s && { ...s, duplicates: importError.candidates });
        setMessage("Not saved: this looks like a recipe that exists already (listed at the top). Save anyway if it is a different one.");
        window.scrollTo(0, 0);
      } else if (e instanceof ApiError && e.fields) {
        setErrors(e.fields);
        setMessage(`Please fix ${Object.keys(e.fields).length} field(s).`);
      } else if (e instanceof NetworkError) {
        setMessage("You are offline - saving a recipe needs a connection. Your draft stays on this screen.");
      } else if (e instanceof AuthError) {
        setMessage("Your login has expired. Log in again in another tab, then save - your draft stays on this screen.");
      } else if (e instanceof ApiError) {
        setMessage(`The server could not save the recipe (${e.status}: ${e.message}). Your draft stays on this screen.`);
      } else {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="page editor">
      <h1>{id ? "Edit recipe" : imported ? "Imported recipe" : "New recipe"}</h1>
      {imported && importState && (
        <ImportPanel
          pending={imported.pending}
          problems={importState.problems}
          duplicates={importState.duplicates}
          coverUrl={importState.coverUrl}
          bookmarkIt={bookmarkIt}
          onBookmarkIt={setBookmarkIt}
          onRemoveCover={() => setImportState((s) => s && { ...s, coverUrl: null })}
        />
      )}

      <Labeled label="Title" error={err("title")}>
        <input value={draft.title} onChange={(e) => set("title", e.target.value)} />
      </Labeled>
      <div className="row gap">
        <Labeled label="Yield" error={err("yield.amount") ?? err("yield")}>
          <input inputMode="decimal" value={draft.yieldAmount} onChange={(e) => set("yieldAmount", e.target.value)} placeholder="4" />
        </Labeled>
        <Labeled label="Yield unit" error={err("yield.unit")} grow>
          <input value={draft.yieldUnit} onChange={(e) => set("yieldUnit", e.target.value)} placeholder="servings / cake (26 cm)" />
        </Labeled>
      </div>
      <div className="row gap">
        <Labeled label="Total time (min)" error={err("time.total_min") ?? err("time")}>
          <input inputMode="numeric" value={draft.timeTotal} onChange={(e) => set("timeTotal", e.target.value)} placeholder="45" />
        </Labeled>
        <Labeled label="Active time (min, optional)" error={err("time.active_min")} grow>
          <input inputMode="numeric" value={draft.timeActive} onChange={(e) => set("timeActive", e.target.value)} placeholder="20" />
        </Labeled>
      </div>
      <TagInput
        value={{ tags: draft.tags, text: draft.tagText }}
        onChange={(v) => setDraft((d) => ({ ...d, tags: v.tags, tagText: v.text }))}
        error={err("tags") ?? tagError?.[1]}
        invalid={tagError ? Number(tagError[0].split(".")[1]) : undefined}
      />
      <Labeled label="Source URL" error={err("source_url")}>
        <input type="url" inputMode="url" value={draft.source_url} onChange={(e) => set("source_url", e.target.value)} />
      </Labeled>

      {id && existing && <CoverInput recipe={existing.recipe} staged={cover} onStage={setCover} />}

      <h2>Ingredients</h2>
      <p className="muted small">
        Enter adds a row below. Type or paste lines like <code>200 g flour, sifted</code> into an item field to split them. Backspace in an empty row deletes
        it, Alt+↑/↓ moves a row.
      </p>
      {err("sections") && <p className="error">{err("sections")}</p>}
      {draft.sections.map((s, si) => (
        <fieldset key={s.key} className="section-edit">
          <div className="section-head">
            <input
              className="section-title"
              value={s.title}
              placeholder={draft.sections.length > 1 ? "Section title, e.g. For the sauce" : "Section title (optional)"}
              onChange={(e) => updateSection(si, (x) => ({ ...x, title: e.target.value }))}
              aria-label="Section title"
            />
            <button type="button" className="icon ghost" onClick={() => moveSection(si, -1)} disabled={si === 0} aria-label="Move section up">
              ↑
            </button>
            <button
              type="button"
              className="icon ghost"
              onClick={() => moveSection(si, 1)}
              disabled={si === draft.sections.length - 1}
              aria-label="Move section down"
            >
              ↓
            </button>
            <button
              type="button"
              className="icon ghost danger"
              aria-label="Remove section"
              onClick={() => {
                if (s.rows.some((r) => !isEmptyRow(r)) && !confirm("Remove section and its ingredients?")) return;
                setDraft((d) => ({
                  ...d,
                  sections: d.sections.length > 1 ? d.sections.filter((_, i) => i !== si) : [{ key: k(), title: "", rows: [emptyRow()] }],
                }));
              }}
            >
              ×
            </button>
          </div>

          {s.rows.map((r, ri) => {
            const p = paths.get(r.key);
            const fe = (f: Field): string | undefined => (p ? err(`${p}.${f}`) : undefined);
            const rowErr = p ? err(p) : undefined;
            const common = (f: Field) => ({
              ref: reg(`${r.key}:${f}`),
              value: r[f],
              onKeyDown: onRowKey(si, ri, f),
              "aria-label": f,
              "aria-invalid": fe(f) ? true : undefined,
              className: fe(f) ? "invalid" : undefined,
            });
            return (
              <div key={r.key} className="ing-row">
                <input {...common("qty")} inputMode="decimal" placeholder="qty" onChange={(e) => updateRow(si, ri, "qty", e.target.value)} />
                <input {...common("qtyMax")} inputMode="decimal" placeholder="max" onChange={(e) => updateRow(si, ri, "qtyMax", e.target.value)} />
                <select {...common("unit")} onChange={(e) => updateRow(si, ri, "unit", e.target.value)}>
                  <option value="">-</option>
                  {METRIC_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
                <input
                  {...common("item")}
                  className={`item ${fe("item") ? "invalid" : ""}`}
                  placeholder="item"
                  onChange={(e) => updateRow(si, ri, "item", e.target.value)}
                  onBlur={() => smartSplit(si, ri)}
                  onPaste={onItemPaste(si, ri)}
                />
                <input {...common("prep")} className="prep" placeholder="prep" onChange={(e) => updateRow(si, ri, "prep", e.target.value)} />
                <input
                  {...common("note")}
                  className="note"
                  placeholder="note"
                  enterKeyHint="next"
                  onChange={(e) => updateRow(si, ri, "note", e.target.value)}
                />
                <div className="row-actions">
                  <button type="button" className="icon ghost" tabIndex={-1} onClick={() => moveRow(si, ri, -1)} aria-label="Move up">
                    ↑
                  </button>
                  <button type="button" className="icon ghost" tabIndex={-1} onClick={() => moveRow(si, ri, 1)} aria-label="Move down">
                    ↓
                  </button>
                  <button type="button" className="icon ghost danger" tabIndex={-1} onClick={() => removeRow(si, ri)} aria-label="Delete row">
                    ×
                  </button>
                </div>
                {(rowErr || FIELDS.some(fe)) && (
                  <p className="error row-error">{[rowErr, ...FIELDS.map((f) => (fe(f) ? `${f}: ${fe(f)}` : undefined))].filter(Boolean).join(" · ")}</p>
                )}
              </div>
            );
          })}
          <QuickAdd
            onAdd={(ings) => {
              const rows = ings.map(rowFromIngredient);
              updateSection(si, (x) => {
                const keep = x.rows.filter((r) => !isEmptyRow(r));
                return { ...x, rows: [...keep, ...rows, emptyRow()] };
              });
            }}
          />
        </fieldset>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() => setDraft((d) => ({ ...d, sections: [...d.sections, { key: k(), title: "", rows: [emptyRow()] }] }))}
      >
        + Add section
      </button>

      <MdField label="Steps (markdown, one list item per step)" value={draft.steps_md} onChange={(v) => set("steps_md", v)} error={err("steps_md")} rows={8} />
      <MdField label="Notes (markdown)" value={draft.notes_md} onChange={(v) => set("notes_md", v)} error={err("notes_md")} rows={4} />

      {err("_") && <p className="error">{err("_")}</p>}
      <div className="save-bar">
        {message && <p className={Object.keys(errors).length ? "error" : "muted"}>{message}</p>}
        <div className="row gap">
          <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          {importState && importState.duplicates.length > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => {
                setImportState((s) => s && { ...s, confirmDuplicate: true });
                void save(true);
              }}
            >
              Save anyway
            </button>
          )}
          <button type="button" className="secondary" onClick={() => history.back()}>
            Cancel
          </button>
        </div>
      </div>
    </main>
  );
}

/** What the import found: why AI was not used, review notes, open problems, likely duplicates, the cover candidate. */
function ImportPanel({
  pending,
  problems,
  duplicates,
  coverUrl,
  bookmarkIt,
  onBookmarkIt,
  onRemoveCover,
}: {
  pending: PendingImport;
  problems: string[];
  duplicates: DuplicateCandidate[];
  coverUrl: string | null;
  bookmarkIt: boolean;
  onBookmarkIt: (on: boolean) => void;
  onRemoveCover: () => void;
}) {
  const { draft } = pending;
  return (
    <section className="import-panel" aria-label="Import review">
      {draft.ai_unavailable && (
        <p className="notice ai-banner" role="status">
          {AI_UNAVAILABLE_TEXT[draft.ai_unavailable]}
        </p>
      )}
      <p className="muted small">
        Draft from{" "}
        <a href={draft.recipe.source_url} target="_blank" rel="noreferrer">
          {draft.recipe.source_url}
        </a>
        . Check it, then Save.
        {draft.review_notes.length > 0 && " The review notes are posted as a comment when you save."}
      </p>
      {draft.review_notes.length > 0 && (
        <div>
          <h2 className="small-heading">Review notes</h2>
          <ul className="small">
            {draft.review_notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {problems.length > 0 && (
        <div className="import-problems" role="alert">
          <h2 className="small-heading">To fix before saving</h2>
          <ul className="small">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {duplicates.length > 0 && (
        <div className="notice">
          Possibly the same as:{" "}
          {duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ", "}
              <Link href={`/recipes/${encodeURIComponent(d.id)}`}>{d.title}</Link>
            </span>
          ))}
        </div>
      )}
      {coverUrl && (
        <div className="field cover-edit">
          <span className="label">Cover image</span>
          <div className="staged-frame">
            <img className="cover" src={coverUrl} referrerPolicy="no-referrer" style={{ objectPosition: focusPosition(null) }} alt="Cover from the page" />
            <span className="new-badge">new cover</span>
          </div>
          <div className="row gap wrap">
            <button type="button" className="secondary" onClick={onRemoveCover}>
              Remove cover
            </button>
            <span className="muted small">Downloaded when you save.</span>
          </div>
        </div>
      )}
      <label className="row gap small">
        <input type="checkbox" checked={bookmarkIt} onChange={(e) => onBookmarkIt(e.target.checked)} />
        Bookmark it
      </label>
    </section>
  );
}

const uploadCover = (recipeId: string, file: File): Promise<Recipe> =>
  api<Recipe>(`/recipes/${encodeURIComponent(recipeId)}/cover`, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
    signal: AbortSignal.timeout(120_000),
  });

const NOT_TEXT_INPUTS = new Set(["file", "checkbox", "radio", "button", "submit", "reset", "range", "color", "image"]);
/** Pasting into a text field must keep pasting text (and ingredient lines). */
const isTextTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !NOT_TEXT_INPUTS.has(t.type)) || (t instanceof HTMLElement && t.isContentEditable);

function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/**
 * Replacing the cover is staged: a picked file, a ⌘V/Ctrl+V paste anywhere outside a text field,
 * or the "Paste image" button (clipboard API, for phones) shows the new image here, and the
 * editor uploads it on Save. Same bytes again are a no-op on the server; a new image resets the crop.
 */
function CoverInput({ recipe, staged, onStage }: { recipe: Recipe; staged?: File; onStage: (f: File | undefined) => void }) {
  const [status, setStatus] = useState<string>();
  const url = useObjectUrl(staged);
  const stage = useCallback(
    (file: File): void => {
      const problem = coverFileProblem(file);
      setStatus(problem);
      if (!problem) onStage(file);
    },
    [onStage],
  );

  useEffect(() => {
    const onPaste = (e: globalThis.ClipboardEvent): void => {
      if (isTextTarget(e.target)) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      stage(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [stage]);

  const pasteButton = async (): Promise<void> => {
    if (!navigator.clipboard?.read) return setStatus("This browser cannot read images from the clipboard here. Use ⌘V / Ctrl+V or choose a file.");
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        return stage(new File([blob], `pasted.${COVER_TYPES[type] ?? "img"}`, { type }));
      }
      setStatus("There is no image on the clipboard.");
    } catch (e) {
      setStatus(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Clipboard access was denied. Allow it for this site, or use ⌘V / Ctrl+V."
          : `Could not read the clipboard: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  return (
    <div className="field cover-edit">
      <span className="label">Cover image</span>
      {staged && url ? (
        <div className="staged-cover">
          <div className="staged-frame">
            <img className="cover" src={url} style={{ objectPosition: focusPosition(null) }} alt="New cover preview" />
            <span className="new-badge">new cover</span>
          </div>
          <div className="row gap wrap">
            <button type="button" className="secondary" onClick={() => onStage(undefined)}>
              Undo
            </button>
            <span className="muted small">Uploaded when you save. The crop resets to the default; adjust it after saving.</span>
          </div>
        </div>
      ) : (
        recipe.cover_key && <CoverCrop recipeId={recipe.id} coverKey={recipe.cover_key} saved={recipe.cover_focus ?? null} />
      )}
      <div className="row gap wrap">
        <input
          type="file"
          accept={Object.keys(COVER_TYPES).join(",")}
          aria-label={recipe.cover_key ? "Replace cover image" : "Add cover image"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) stage(file);
          }}
        />
        <button type="button" className="secondary" onClick={() => void pasteButton()}>
          Paste image
        </button>
      </div>
      <span className="muted small">Paste an image (⌘V / Ctrl+V) to replace the cover</span>
      {status && (
        <span className="error" role="status">
          {status}
        </span>
      )}
    </div>
  );
}

const NUDGE: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
const clampPercent = (v: number): number => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;

/**
 * Focal point used by every cropped rendering. Drag or tap on the full image, or nudge with the
 * arrow keys. Saved on release through the outbox, so it works offline like a rating.
 */
function CoverCrop({ recipeId, coverKey, saved }: { recipeId: string; coverKey: string; saved: CoverFocus | null }) {
  const user = useSignal(currentUser);
  const [draft, setDraft] = useState<CoverFocus>();
  const img = useRef<HTMLImageElement>(null);
  const focus = draft ?? saved ?? DEFAULT_FOCUS;
  const src = coverUrl(coverKey);
  const position = focusPosition(focus);
  const at = (e: PointerEvent): CoverFocus | undefined => (img.current ? pointToFocus(e.clientX, e.clientY, img.current.getBoundingClientRect()) : undefined);
  const commit = (f: CoverFocus | null): void => {
    setDraft(undefined);
    void setCoverFocus(recipeId, user, f);
  };
  return (
    <div className="cover-crop">
      <span className="label">Cover crop</span>
      <span className="muted small">Drag or tap the part of the photo that should stay in view. The previews are the exact crops.</span>
      <div className="crop-layout">
        <div
          className="focus-pick"
          tabIndex={0}
          role="group"
          aria-label={`Focal point ${focus.x}% from the left, ${focus.y}% from the top. Arrow keys move it.`}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.focus();
            setDraft(at(e));
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) setDraft(at(e));
          }}
          onPointerUp={(e) => {
            const f = at(e);
            if (f) commit(f);
          }}
          onPointerCancel={() => setDraft(undefined)}
          onKeyDown={(e) => {
            const d = NUDGE[e.key];
            if (!d) return;
            e.preventDefault();
            setDraft({ x: clampPercent(focus.x + d[0]), y: clampPercent(focus.y + d[1]) });
          }}
          onKeyUp={(e) => {
            if (NUDGE[e.key] && draft) commit(draft);
          }}
        >
          <img ref={img} src={src} alt="Full cover image" draggable={false} />
          <span className="focus-dot" style={{ left: `${focus.x}%`, top: `${focus.y}%` }} />
        </div>
        <div className="crop-previews">
          <figure>
            <img className="thumb" src={src} style={{ objectPosition: position }} alt="" />
            <figcaption className="muted small">List card</figcaption>
          </figure>
          <figure>
            <img className="cover" src={src} style={{ objectPosition: position }} alt="" />
            <figcaption className="muted small">Recipe header</figcaption>
          </figure>
        </div>
      </div>
      <div className="row gap">
        <span className="muted small">{saved ? `Focus ${saved.x}% / ${saved.y}%` : "Default focus (centre, a bit above the middle)"}</span>
        {saved && (
          <button type="button" className="link" onClick={() => commit(null)}>
            reset
          </button>
        )}
      </div>
    </div>
  );
}

/** One free-text line -> parsed row(s). Enter adds and keeps focus for the next line. */
function QuickAdd({ onAdd }: { onAdd: (ings: Ingredient[]) => void }) {
  const [text, setText] = useState("");
  const preview = parseIngredientLine(text);
  return (
    <div className="quick-add">
      <input
        value={text}
        placeholder="Quick add: 2-3 cloves garlic, minced"
        enterKeyHint="enter"
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (!/\r?\n/.test(t.trim())) return;
          e.preventDefault();
          onAdd(parseIngredientBlock(t).flatMap((s) => s.ingredients));
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (preview) onAdd([preview]);
          setText("");
        }}
        aria-label="Quick add ingredient"
      />
      {preview && text && (
        <span className="muted small parse-preview">
          → {[preview.qty, preview.qtyMax && `-${preview.qtyMax}`, preview.unit].filter(Boolean).join(" ")} <b>{preview.item}</b>
          {preview.prep && `, ${preview.prep}`}
          {preview.note && ` (${preview.note})`}
        </span>
      )}
    </div>
  );
}

function Labeled({ label, error, grow, children }: { label: string; error?: string; grow?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${grow ? "grow" : ""} ${error ? "has-error" : ""}`}>
      <span className="label">{label}</span>
      {children}
      {error && <span className="error">{error}</span>}
    </label>
  );
}

function MdField(props: { label: string; value: string; onChange: (v: string) => void; error?: string; rows: number }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className={`field ${props.error ? "has-error" : ""}`}>
      <div className="row between">
        <span className="label">{props.label}</span>
        <div className="tabs">
          <button type="button" className={!preview ? "on" : ""} onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" className={preview ? "on" : ""} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      </div>
      {preview ? (
        <div className="preview">
          <Markdown src={props.value || "_nothing yet_"} />
        </div>
      ) : (
        <textarea value={props.value} rows={props.rows} onChange={(e) => props.onChange(e.target.value)} />
      )}
      {props.error && <span className="error">{props.error}</span>}
    </div>
  );
}
