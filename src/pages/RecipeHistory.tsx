import { useCallback, useEffect, useState } from "react";
import {
  type Change,
  contentOf,
  diffRecipes,
  type LineOp,
  type RecipeDiff,
  type Revision,
  type RevisionListItem,
  type RevisionSource,
  restoredContent,
} from "../../shared/revisions";
import type { Recipe } from "../../shared/schema";
import { AuthError, api, NetworkError } from "../lib/api";
import { Link } from "../lib/router";
import { useSignal } from "../lib/signal";
import { detailSignal, loadRecipe, replaceRecipe } from "../store/recipes";
import { syncStatus } from "../store/sync";

const SOURCE_LABEL: Record<RevisionSource, string> = {
  baseline: "Original (before history started)",
  editor: "Edited",
  tags: "Tags changed",
  import: "Imported",
  restore: "Restored an older version",
  mcp: "Changed by the assistant",
  "url-import": "Imported from a link",
  migration: "Bulk change (tag groups, diet tags)",
};

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const failure = (e: unknown, doing: string): string => {
  if (e instanceof NetworkError) return `You are offline - ${doing} needs a connection.`;
  if (e instanceof AuthError) return "Your login has expired. Log in again, then retry.";
  return `Could not ${doing}: ${e instanceof Error ? e.message : String(e)}`;
};

/** Online only: versions live on the server, and restoring is not queued in the outbox. */
export function RecipeHistory({ id }: { id: string }) {
  const state = useSignal(detailSignal(id));
  const { online } = useSignal(syncStatus);
  const [list, setList] = useState<RevisionListItem[]>();
  const [selected, setSelected] = useState<Revision>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const path = `/recipes/${encodeURIComponent(id)}/revisions`;

  const loadList = useCallback(async (): Promise<void> => {
    try {
      setList(await api<RevisionListItem[]>(path));
    } catch (e) {
      setMessage(failure(e, "loading the history"));
    }
  }, [path]);

  useEffect(() => {
    void loadRecipe(id);
    void loadList();
  }, [id, loadList]);

  const select = async (rev: RevisionListItem): Promise<void> => {
    setMessage(undefined);
    try {
      setSelected(await api<Revision>(`${path}/${rev.id}`));
    } catch (e) {
      setMessage(failure(e, "loading that version"));
    }
  };

  const restore = async (rev: Revision): Promise<void> => {
    if (!confirm(`Restore the version from ${when(rev.created_at)}? The current content and tags are replaced; the current version stays in the history.`))
      return;
    setBusy(true);
    setMessage(undefined);
    try {
      const recipe = await api<Recipe>(`${path}/${rev.id}/restore`, { method: "POST" });
      await replaceRecipe({ recipe, comments: state.detail?.comments ?? [] });
      setSelected(undefined);
      setMessage(`Restored the version from ${when(rev.created_at)}.`);
      await loadList();
    } catch (e) {
      setMessage(failure(e, "restoring"));
    } finally {
      setBusy(false);
    }
  };

  const recipe = state.detail?.recipe;
  const newest = list?.[0];
  return (
    <main className="page history">
      <p>
        <Link href={`/recipes/${encodeURIComponent(id)}`}>← {recipe?.title ?? "Recipe"}</Link>
      </p>
      <h1>History</h1>
      {!online && <p className="notice">You are offline. The history and restoring need a connection.</p>}
      {message && <p className="notice">{message}</p>}
      {list?.length === 0 && <p className="muted">No changes recorded yet. The first change also keeps the original version.</p>}
      {list && list.length > 0 && (
        <ol className="revisions">
          {list.map((r, i) => (
            <li key={r.id}>
              <button type="button" className={selected?.id === r.id ? "revision on" : "revision"} onClick={() => void select(r)}>
                <span>
                  <b>{i === list.length - 1 && r.source === "editor" ? "Created" : SOURCE_LABEL[r.source]}</b>
                  {r.author && ` by ${r.author}`}
                  {r.id === newest?.id && <span className="pill">current</span>}
                </span>
                <span className="muted small">
                  {when(r.created_at)}
                  {r.changes.length > 0 && ` · ${r.changes.join(" · ")}`}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {selected && recipe && (
        <section className="revision-detail">
          <h2>Version from {when(selected.created_at)}</h2>
          {selected.id === newest?.id ? (
            <p className="muted">This is the current version.</p>
          ) : (
            <>
              <DiffView diff={diffRecipes(contentOf(recipe), restoredContent(selected.snapshot))} />
              <button type="button" className="primary" disabled={busy || !online} onClick={() => void restore(selected)}>
                {busy ? "Restoring..." : "Restore this version"}
              </button>
              {!online && <span className="muted small"> Needs a connection.</span>}
            </>
          )}
        </section>
      )}
    </main>
  );
}

function FieldChange({ label, change }: { label: string; change?: Change }) {
  if (!change) return null;
  return (
    <p>
      <b>{label}:</b> <del>{change.from || "(none)"}</del> → <ins>{change.to || "(none)"}</ins>
    </p>
  );
}

function Lines({ label, ops }: { label: string; ops?: LineOp[] }) {
  if (!ops) return null;
  return (
    <>
      <h3>{label}</h3>
      <pre className="line-diff">
        {ops.map((l, i) => (
          <div key={i} className={l.op}>
            {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
    </>
  );
}

/** Current version -> selected version: what restoring would change. */
function DiffView({ diff }: { diff: RecipeDiff }) {
  const { tags, ingredients: ing } = diff;
  const empty =
    !diff.title &&
    !diff.yield &&
    !diff.time &&
    !diff.source_url &&
    !diff.sections &&
    !diff.steps &&
    !diff.notes &&
    tags.added.length + tags.removed.length + ing.added.length + ing.removed.length + ing.changed.length === 0;
  if (empty) return <p className="muted">Same content as the current version (only the order of ingredients may differ).</p>;
  return (
    <div className="diff">
      <p className="muted small">
        What restoring this version would change: <ins>+ comes back</ins>, <del>- goes away</del>.
      </p>
      <FieldChange label="Title" change={diff.title} />
      <FieldChange label="Yield" change={diff.yield} />
      <FieldChange label="Time" change={diff.time} />
      <FieldChange label="Source" change={diff.source_url} />
      <FieldChange label="Sections" change={diff.sections} />
      {tags.added.length + tags.removed.length > 0 && (
        <p>
          <b>Tags:</b>{" "}
          {tags.added.map((t) => (
            <ins key={`+${t}`}>+{t} </ins>
          ))}
          {tags.removed.map((t) => (
            <del key={`-${t}`}>-{t} </del>
          ))}
        </p>
      )}
      {ing.added.length + ing.removed.length + ing.changed.length > 0 && (
        <>
          <h3>Ingredients</h3>
          <ul className="ing-diff">
            {ing.added.map((l, i) => (
              <li key={`a${i}`} className="add">
                + {l}
              </li>
            ))}
            {ing.removed.map((l, i) => (
              <li key={`d${i}`} className="del">
                - {l}
              </li>
            ))}
            {ing.changed.map((c, i) => (
              <li key={`c${i}`} className="change">
                ~ <del>{c.from}</del> → <ins>{c.to}</ins>
              </li>
            ))}
          </ul>
        </>
      )}
      <Lines label="Steps" ops={diff.steps} />
      <Lines label="Notes" ops={diff.notes} />
    </div>
  );
}
