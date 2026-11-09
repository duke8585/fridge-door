import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serviceWorker } from "./sw-plugin.ts";

export default defineConfig({
  plugins: [react(), cloudflare(), serviceWorker()],
  server: { port: 8788, strictPort: true },
  preview: { port: 8788, strictPort: true },
});
