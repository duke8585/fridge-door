import { useEffect, useRef } from "react";
import { loginHref } from "../lib/api";
import { Link } from "../lib/router";
import { useSignal } from "../lib/signal";
import { theme, toggleTheme } from "../lib/theme";
import { currentUser, forgetUser, userKnown } from "../lib/user";
import { pendingCount } from "../store/outbox";
import { dismissRejected, rejected, syncStatus } from "../store/sync";
import { useUncheckedCount } from "./ShoppingList";

export function Header({ onOpenShopping }: { onOpenShopping: () => void }) {
  const mode = useSignal(theme);
  const themeLabel = mode === "dark" ? "Switch to light mode" : "Switch to dark mode";
  const user = useSignal(currentUser);
  const known = useSignal(userKnown);
  const status = useSignal(syncStatus);
  const pending = useSignal(pendingCount);
  const count = useUncheckedCount();
  const rej = useSignal(rejected);
  const ref = useRef<HTMLElement>(null);
  // Publish the header's height (it wraps to two rows on phones) so sticky bars below it can sit flush.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement.style;
    const observer = new ResizeObserver(() => root.setProperty("--header-h", `${el.offsetHeight}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.removeProperty("--header-h");
    };
  }, []);
  const label = status.authRequired ? "logged out" : !status.online ? "offline" : pending > 0 ? `${pending} to sync` : "synced";
  return (
    <header className="app-header" ref={ref}>
      <Link href="/" className="brand">
        Fridge Door
      </Link>
      <button type="button" className="header-icon ghost" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          {mode === "dark" ? (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
            </>
          ) : (
            <path d="M20.5 13.1A8.5 8.5 0 0 1 10.9 3.5a8.5 8.5 0 1 0 9.6 9.6Z" />
          )}
        </svg>
      </button>
      <a
        className="header-icon"
        href="https://github.com/duke8585/fridge-door"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Fridge Door on GitHub"
        title="Fridge Door on GitHub"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.4-1.22.72-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15A10.8 10.8 0 0 1 12 6.17c.96 0 1.92.13 2.81.38 2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.04.76 2.1v3.08c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" />
        </svg>
      </a>
      <span className={`sync ${status.online && !status.authRequired ? (pending ? "pending" : "ok") : "off"}`} title={status.lastError ?? label}>
        <i />
        {status.authRequired ? <a href={loginHref()}>log in{pending > 0 ? ` (${pending} to sync)` : ""}</a> : label}
      </span>
      {rej.count > 0 && (
        <button type="button" className="sync-rejected" title={rej.last} onClick={dismissRejected} aria-label="Dismiss rejected changes notice">
          {rej.count === 1 ? "1 change was rejected" : `${rej.count} changes were rejected`} ×
        </button>
      )}
      <form method="post" action="/logout" className="who small" onSubmit={forgetUser}>
        {known && <span title="Logged in as">{user}</span>}
        <button type="submit" className="link">
          log out
        </button>
      </form>
      <button type="button" className="cart" onClick={onOpenShopping} aria-label="Shopping list">
        🛒{count > 0 && <span className="badge">{count}</span>}
      </button>
    </header>
  );
}
