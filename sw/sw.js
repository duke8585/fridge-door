// Service worker: precache the app shell, serve it cache-first.
// Data never goes through the SW cache - the app reads IndexedDB and syncs itself.
// The one /api exception is cover images: their URLs are content-addressed, so a cached copy is never stale.
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE_URLS__;
const CACHE = `shell-${VERSION}`;
// Not versioned: covers survive deploys. Bounded, oldest entries evicted first.
const COVERS = "covers-v1";
const MAX_COVERS = 200;

// The login flow and the MCP OAuth endpoints are served by the Worker. Never cached and never
// answered with the shell.
const WORKER_PATHS = new Set(["/login", "/logout", "/authorize", "/token", "/register", "/mcp"]);
const isAuthPath = (path) => WORKER_PATHS.has(path) || path.startsWith("/auth/") || path.startsWith("/.well-known/");

/** Only real 200s for the URL we asked for: a login redirect to /login must never be stored as "/". */
const cacheable = (res) => res.ok && !res.redirected && res.type === "basic";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (url) => {
          const res = await fetch(url, { cache: "reload" });
          if (!cacheable(res)) throw new Error(`precache ${url}: ${res.status}${res.redirected ? " (redirected)" : ""}`);
          await c.put(url, res);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== COVERS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function coverFirst(req) {
  const cache = await caches.open(COVERS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_COVERS)).map((k) => cache.delete(k)));
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/covers/")) {
    event.respondWith(coverFirst(req));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || isAuthPath(url.pathname)) return;

  // SPA navigations: always answer with the cached shell (instant + offline),
  // falling back to network if the cache is somehow missing.
  if (req.mode === "navigate") {
    event.respondWith(caches.match("/", { cacheName: CACHE }).then((hit) => hit || fetch(req)));
    return;
  }

  // Hashed assets / public files: cache-first, fill cache on miss.
  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
