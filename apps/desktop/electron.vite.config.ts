import { cpSync } from "node:fs";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

import { version } from "./package.json";

/** The renderer's public dir, assembled under node_modules to keep it out of `src`. */
const rendererPublicDir = resolve(__dirname, "node_modules/.renderer-assets");

/** Copies the app icons, without the SVG sources, for the window and favicon. */
function rendererAssets(): Plugin {
  return {
    name: "renderer-assets",
    buildStart() {
      cpSync(
        resolve(__dirname, "../../assets/icons"),
        resolve(rendererPublicDir, "icons"),
        { recursive: true, filter: (path) => !path.endsWith(".svg") },
      );
    },
  };
}

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, "src/electron/main.ts") },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, "src/electron/preload.ts") },
      rollupOptions: { output: { format: "cjs" } }, // Sandboxed preloads need CJS.
    },
  },
  renderer: {
    root: resolve(__dirname, "src"),
    define: { __APP_VERSION__: JSON.stringify(version) },
    publicDir: rendererPublicDir,
    build: {
      minify: true, // electron-vite does not minify by default; V8 parses less.
      rollupOptions: { input: resolve(__dirname, "src/index.html") },
    },
    worker: { format: "es" },
    resolve: {
      alias: { "@": resolve(__dirname, "src") },
    },
    plugins: [react(), tailwindcss(), rendererAssets()],
  },
});
