import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * In production `/app` is served by Vercel's `cleanUrls` (dist/app.html).
 * The dev server has no such mapping, so teach it the same one — otherwise
 * every landing CTA 404s while developing.
 */
function appRouteAlias(): Plugin {
  return {
    name: "vellum-app-route-alias",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split("?")[0];
        if (path === "/app" || path === "/app/") {
          req.url = "/app.html" + req.url!.slice(path.length);
        }
        next();
      });
    },
  };
}

/** Files copied verbatim from public/ that belong in the offline shell. */
const PUBLIC_SHELL = [
  "/manifest.webmanifest",
  "/favicon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
];

/**
 * Emitted files the shell can boot without, left to the service worker's
 * runtime cache instead of tripling the install download:
 *  - the landing page's product screenshots (only a first-time visitor sees
 *    them, and a first-time visitor is by definition online);
 *  - the .ttf/.woff fallbacks of every KaTeX and Inter face — each @font-face
 *    lists woff2 first, so that is the only format a service-worker-capable
 *    browser will ever fetch.
 */
const RUNTIME_CACHED =
  /^assets\/(hero|editor|database|publish|og)-|\.(ttf|woff)$/;

/**
 * Emits dist/sw.js from src/pwa/sw.js, with the shell's file list and a
 * content-derived cache name substituted in. Hand-rolled rather than
 * vite-plugin-pwa: the requirements are one page of code, and the plugin's
 * Vite 8 support is not something to bet the build on.
 */
function vellumPWA(): Plugin {
  return {
    name: "vellum-pwa",
    apply: "build",
    // After vite:build-html, so the two HTML entries are in the bundle too.
    enforce: "post",
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).filter((f) => !RUNTIME_CACHED.test(f));
      const precache = [
        ...PUBLIC_SHELL,
        ...emitted.map((f) => "/" + f),
      ].sort();

      // Hash the exact shell contents so a rebuild always mints a new cache
      // name and `activate` evicts the previous one.
      const hash = createHash("sha256")
        .update(precache.join("\n"))
        .digest("hex")
        .slice(0, 8);

      // Global replace: both placeholders are also named in sw.js's header
      // comment, and a first-match-only replace would patch the prose.
      const source = readFileSync(resolve(__dirname, "src/pwa/sw.js"), "utf8")
        .replace(/__CACHE_NAME__/g, () => `vellum-${hash}`)
        .replace(/__PRECACHE__/g, () => JSON.stringify(precache, null, 2));

      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), appRouteAlias(), vellumPWA()],
  // Relative asset URLs: one dist/ has to work from Electron's
  // file://…/dist/app.html, from "/", from "/app.html" and from "/app".
  // (The one bad case, "/app/", is ruled out by trailingSlash:false in
  // vercel.json — and by the dev alias above.)
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // Two entries: the marketing landing at "/" and the SPA at "/app".
      input: {
        landing: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
      },
    },
  },
});
