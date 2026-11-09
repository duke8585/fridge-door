/**
 * Tiny replacement for vite-plugin-pwa: after the client build, emit /sw.js
 * with the list of hashed assets + public files baked in as the precache
 * manifest. The service worker source is plain JS in sw/sw.js.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export function serviceWorker(): Plugin {
  return {
    name: "recipes:service-worker",
    apply: "build",
    applyToEnvironment: (env) => env.name === "client",
    generateBundle(_opts, bundle) {
      const publicFiles = readdirSync(resolve(import.meta.dirname, "public")).map((f) => `/${f}`);
      // "/" is the SPA shell (index.html may not be in the bundle yet when this hook runs).
      const built = Object.keys(bundle).filter((f) => !f.startsWith(".") && f !== "index.html").map((f) => `/${f}`);
      const urls = [...new Set(["/", ...built, ...publicFiles])].filter((u) => u !== "/sw.js").sort();
      const version = createHash("sha256").update(urls.join("\n")).digest("hex").slice(0, 10);
      const src = readFileSync(resolve(import.meta.dirname, "sw/sw.js"), "utf8")
        .replace("__PRECACHE_URLS__", JSON.stringify(urls))
        .replace("__VERSION__", version);
      this.emitFile({ type: "asset", fileName: "sw.js", source: src });
    },
  };
}
