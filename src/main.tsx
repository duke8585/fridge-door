import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadShopping } from "./store/shopping";
import { startSync } from "./store/sync";
import "./styles.css";

// Local first: hydrate from IndexedDB before the first paint that needs it,
// then start the outbox/poll loop. The UI never waits on the network.
void loadShopping().then(startSync);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A service worker from before the MCP release answers /authorize with this shell. Fetch the new
// one (it skips waiting and claims this tab) and load the page again, once.
if ("serviceWorker" in navigator && location.pathname === "/authorize" && !sessionStorage.getItem("fd_sw_retry")) {
  sessionStorage.setItem("fd_sw_retry", "1");
  const reload = (): void => location.reload();
  navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  setTimeout(reload, 3000);
  void navigator.serviceWorker.getRegistration().then((r) => r?.update());
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e: unknown) => console.warn("SW registration failed", e));
  });
}
