import { defineConfig } from "vite";
import { resolve } from "node:path";

// One-page static site: the dashboard is index.html; the design system lives in src/shared.
const pages = ["index"];

export default defineConfig({
  base: "./",
  // ES2022 for top-level await (satellite.js); every current browser supports it
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  esbuild: { target: "es2022" },
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p === "index" ? "main" : p, resolve(__dirname, `${p}.html`)])),
      // vendor chunks cache separately from the dashboard code
      output: { manualChunks: { maplibre: ["maplibre-gl"], d3: ["d3"] } },
    },
  },
  server: { port: 5173 },
});
