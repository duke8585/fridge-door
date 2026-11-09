import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests do not boot workerd.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Inlined so the alias below reaches its `cloudflare:workers` import.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
  resolve: { alias: { "cloudflare:workers": resolve(import.meta.dirname, "test/worker/cloudflare-workers.ts") } },
});
