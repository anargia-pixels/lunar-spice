import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

import { version } from "./package.json";
import routerConfig from "./tsr.config.json" with { type: "json" };

/**
 * The files the site serves at their plain paths, assembled under node_modules so the
 * source tree keeps only the committed files.
 */
const publicDir = resolve(import.meta.dirname, "node_modules/.web-assets");

/** Copies this app's public files and the icons it shares with the desktop app. */
function servedFiles(): Plugin {
  return {
    name: "served-files",
    buildStart() {
      rmSync(publicDir, { force: true, recursive: true });
      cpSync(resolve(import.meta.dirname, "public"), publicDir, {
        recursive: true,
      });
      cpSync(
        resolve(import.meta.dirname, "../../assets/icons"),
        resolve(publicDir, "icons"),
        { filter: isWebIcon, recursive: true },
      );
    },
  };
}

/** Keeps the icons; drops the Aseprite sources and the macOS `.icns`. */
function isWebIcon(path: string) {
  return !path.endsWith(".ase") && !path.endsWith(".icns");
}

const config = defineConfig({
  publicDir,
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { tsconfigPaths: true },
  worker: { format: "es" },
  plugins: [
    tailwindcss(),
    // Next.js-style app router: `page`, `layout` and `route` files are routes;
    // other files beside them are the page's own components. tsr.config.json
    // holds the same rules for the `tsr generate` CLI; this plugin resolves the
    // folder from `src`.
    tanstackStart({
      router: {
        routesDirectory: "app",
        indexToken: routerConfig.indexToken,
        routeToken: routerConfig.routeToken,
        routeFileIgnorePattern: routerConfig.routeFileIgnorePattern,
      },
      // Rendered at build time and served as static files. The editor skips SSR,
      // so its page is the same empty shell for every visitor.
      pages: [{ path: "/" }, { path: "/app" }],
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false, // Render only the pages listed above.
        autoSubfolderIndex: false, // Write app.html, not app/index.html.
        crawlLinks: false, // Do not follow links to more pages.
      },
    }),
    viteReact(),
    servedFiles(),
  ],
});

export default config;
