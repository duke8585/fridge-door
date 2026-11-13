import { type AnchorHTMLAttributes, type MouseEvent } from "react";
import { signal, useSignal } from "./signal";

/** ~30-line history router: enough for 5 routes, no dependency. */
const path = signal(location.pathname + location.search);
window.addEventListener("popstate", () => path.set(location.pathname + location.search));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  path.set(to);
  window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSignal(path);
}

export type Route =
  | { name: "list" }
  | { name: "bookmarks" }
  | { name: "new"; importToken?: string }
  | { name: "import" }
  | { name: "recipe"; id: string }
  | { name: "edit"; id: string }
  | { name: "history"; id: string }
  | { name: "shopping" }
  | { name: "notFound" };

export function matchRoute(full: string): Route {
  const [pathPart, query = ""] = full.split("?");
  const p = pathPart!.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "list" };
  if (p === "/bookmarks") return { name: "bookmarks" };
  if (p === "/shopping") return { name: "shopping" };
  if (p === "/import") return { name: "import" };
  if (p === "/recipes/new") return { name: "new", importToken: new URLSearchParams(query).get("import") ?? undefined };
  let m = p.match(/^\/recipes\/([^/]+)\/edit$/);
  if (m) return { name: "edit", id: decodeURIComponent(m[1]!) };
  m = p.match(/^\/recipes\/([^/]+)\/history$/);
  if (m) return { name: "history", id: decodeURIComponent(m[1]!) };
  m = p.match(/^\/recipes\/([^/]+)$/);
  if (m) return { name: "recipe", id: decodeURIComponent(m[1]!) };
  return { name: "notFound" };
}

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    props.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || props.target) return;
    e.preventDefault();
    navigate(props.href);
  };
  return <a {...props} onClick={onClick} />;
}
