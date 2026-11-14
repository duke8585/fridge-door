import { useEffect, useRef, useState } from "react";
import type { DuplicateCandidate } from "../../shared/duplicates";
import type { AiUnavailable, UrlImportDraft, UrlImportError, UrlImportStatus } from "../../shared/urlImport";
import { ApiError, AuthError, api, loginHref, NetworkError } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { stashImport } from "../store/importDraft";

type State =
  | { step: "idle" }
  | { step: "running"; started: number }
  | { step: "duplicate"; candidates: DuplicateCandidate[] }
  | { step: "error"; message: string; login?: boolean };

/** Shown before an import starts; the draft repeats the reason (AI_UNAVAILABLE_TEXT). */
const STATUS_TEXT: Record<AiUnavailable, string> = {
  credits_exhausted: "AI import credits are used up, so imports are filled without AI for now. Top up the Anthropic credits to get full imports again.",
  key_rejected: "The Anthropic API key was rejected, so imports are filled without AI for now.",
  not_configured: "AI import is not set up on this server, so imports are filled without AI.",
};

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;

/**
 * Share targets differ: Android puts the link in `url` or only in `text`, the iOS Shortcut sends
 * `url`. Text around a shared link is usually the page title, so it is not used as notes.
 */
function fromQuery(search: string): { url: string; notes: string } {
  const q = new URLSearchParams(search);
  const url = q.get("url")?.trim() || q.get("text")?.match(URL_IN_TEXT)?.[0] || "";
  return { url, notes: q.get("notes") ?? "" };
}

function errorMessage(e: unknown): { message: string; login?: boolean } {
  if (e instanceof NetworkError) return { message: "You are offline, or the server took too long. Importing needs a connection." };
  if (e instanceof AuthError) return { message: "Your login has expired.", login: true };
  if (e instanceof ApiError) {
    if (e.fields) return { message: Object.values(e.fields)[0] ?? "Check the link." };
    const body = e.body as UrlImportError | undefined;
    if (body?.error === "fetch_failed") {
      const hint = body.failure === "blocked" ? " Copy the recipe text into the notes and import the link again, or type it in." : "";
      return { message: `Could not read the page: ${body.message}${hint}` };
    }
    if (body?.error === "rate_limited" || body?.error === "model_failed") return { message: body.message };
    return { message: `The server could not import the link (${e.status}: ${e.message}).` };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

export function ImportPage() {
  const initial = useRef(fromQuery(location.search));
  const [url, setUrl] = useState(initial.current.url);
  const [notes, setNotes] = useState(initial.current.notes);
  const [state, setState] = useState<State>({ step: "idle" });
  const [status, setStatus] = useState<UrlImportStatus>();
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);

  useEffect(() => {
    void api<UrlImportStatus>("/import-url/status")
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (state.step !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.step]);

  const run = async (force = false): Promise<void> => {
    if (!url.trim()) return setState({ step: "error", message: "Paste a link first." });
    setState({ step: "running", started: Date.now() });
    setNow(Date.now());
    try {
      const draft = await api<UrlImportDraft>("/import-url", {
        method: "POST",
        json: { url: url.trim(), notes: notes.trim() || undefined, force },
        signal: AbortSignal.timeout(180_000),
      });
      navigate(`/recipes/new?import=${stashImport({ draft, forced: force })}`, { replace: true });
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as UrlImportError | undefined) : undefined;
      if (body?.error === "duplicate") setState({ step: "duplicate", candidates: body.candidates });
      else setState({ step: "error", ...errorMessage(e) });
    }
  };

  // A shared link (/import?url=...) starts right away, once.
  useEffect(() => {
    if (started.current || !initial.current.url) return;
    started.current = true;
    history.replaceState(null, "", "/import");
    void run();
  }, []);

  const running = state.step === "running";
  const seconds = running ? Math.max(0, Math.round((now - state.started) / 1000)) : 0;

  return (
    <main className="page import-page">
      <h1>Import from a link</h1>
      {status && status.ai !== "available" && (
        <p className="notice ai-banner" role="status">
          {STATUS_TEXT[status.ai]}
        </p>
      )}
      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="field">
          <span className="label">Recipe page</span>
          <input type="url" inputMode="url" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} disabled={running} required />
        </label>
        <label className="field">
          <span className="label">Notes (optional)</span>
          <textarea
            rows={3}
            placeholder="e.g. we double the garlic. For a video, paste the recipe text from the caption here."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={running}
          />
        </label>
        <div className="row gap wrap">
          <button type="submit" className="primary" disabled={running}>
            {running ? "Importing..." : "Import"}
          </button>
          <Link href="/" className="button secondary">
            Cancel
          </Link>
        </div>
      </form>

      {running && (
        <p className="muted import-progress" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Reading the page and writing the draft ({seconds} s). This usually takes 10 to 30 seconds.
        </p>
      )}
      {state.step === "duplicate" && (
        <div className="notice" role="alert">
          <p>This link was imported before:</p>
          <ul>
            {state.candidates.map((c) => (
              <li key={c.id}>
                <Link href={`/recipes/${encodeURIComponent(c.id)}`}>{c.title}</Link>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => void run(true)}>
            Import anyway
          </button>
        </div>
      )}
      {state.step === "error" && (
        <p className="error" role="alert">
          {state.message} {state.login && <a href={loginHref()}>Log in again</a>}
        </p>
      )}
      <p className="muted small">
        The page is read on the server and turned into a draft in the recipe editor. Nothing is saved until you press Save there. Instagram, TikTok and YouTube
        links become stubs unless you paste the recipe into the notes.
      </p>
    </main>
  );
}
