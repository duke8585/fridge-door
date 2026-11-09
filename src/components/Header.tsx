import { Link } from "../lib/router";
import { useSignal } from "../lib/signal";
import { currentUser, forgetUser, userKnown } from "../lib/user";
import { pendingCount } from "../store/outbox";
import { loginHref } from "../lib/api";
import { dismissRejected, rejected, syncStatus } from "../store/sync";
import { useUncheckedCount } from "./ShoppingList";

export function Header({ onOpenShopping }: { onOpenShopping: () => void }) {
  const user = useSignal(currentUser);
  const known = useSignal(userKnown);
  const status = useSignal(syncStatus);
  const pending = useSignal(pendingCount);
  const count = useUncheckedCount();
  const rej = useSignal(rejected);
  const label = status.authRequired ? "logged out" : !status.online ? "offline" : pending > 0 ? `${pending} to sync` : "synced";
  return (
    <header className="app-header">
      <Link href="/" className="brand">
        Fridge Door
      </Link>
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
