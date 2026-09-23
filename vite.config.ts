import { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * In production `/app` and `/help` are served by Vercel's `cleanUrls`
 * (dist/app.html, dist/help.html). The dev server has no such mapping, so
 * teach it the same one — otherwise every landing CTA and every Help link
 * 404s while developing.
 */
const CLEAN_URLS: Record<string, string> = {
  "/app": "/app.html",
  "/help": "/help.html",
  "/legal": "/legal.html",
};

function appRouteAlias(): Plugin {
  return {
    name: "vellum-app-route-alias",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        // "/app" and "/app/" both map; the query string rides along.
        const target = CLEAN_URLS[path.replace(/\/$/, "")];
        if (target) req.url = target + req.url!.slice(path.length);
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
 *
 * The screenshot half is pinned to `.png` on purpose: the app entry is
 * code-split, and a lazy chunk that happened to be named `editor-*.js` or
 * `database-*.js` would otherwise be dropped from the offline shell — it
 * would work online and die offline. `vellumPWA` also refuses to build if
 * any script or stylesheet ends up excluded.
 */
const RUNTIME_CACHED =
  /^assets\/(hero|editor|database|publish|og)-[^/]*\.png$|\.(ttf|woff)$/;

/**
 * Build identity: the git short sha (Vercel exposes it as an env var; local
 * builds ask git). Baked into every bundle as `__VELLUM_BUILD__` and emitted
 * as dist/build.json, so the packaged Mac app can tell on launch that the
 * hosted site has moved on — its screens are frozen at build time while the
 * web app updates itself, and a stale desktop build once hid a whole feature
 * (the AI plan card) for five weeks without anyone noticing.
 */
const BUILD_ID: string = (() => {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  if (fromVercel) return fromVercel;
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
})();

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
      // Precache the URLs a browser actually navigates to, not the files on
      // disk. Vercel's cleanUrls 308s /app.html → /app, and a *redirected*
      // cached response cannot be used to answer a navigation request (those
      // carry redirect:"manual"), so caching /app.html would silently break
      // the offline shell in production while working fine under preview.
      const CANONICAL = {
        "index.html": "/",
        "app.html": "/app",
        "help.html": "/help",
        "legal.html": "/legal",
      };
      const emitted = Object.keys(bundle).filter((f) => !RUNTIME_CACHED.test(f));
      // Every lazy chunk must be in the shell, or its feature dies offline.
      const dropped = Object.keys(bundle).filter(
        (f) => /\.(js|css)$/.test(f) && !emitted.includes(f),
      );
      if (dropped.length > 0) {
        this.error(
          `vellum-pwa: code excluded from the precache: ${dropped.join(", ")}`,
        );
      }
      const precache = [
        ...PUBLIC_SHELL,
        ...emitted.map((f) => CANONICAL[f] ?? "/" + f),
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

      // The build's identity, for the Mac app's update check. Emitted after
      // the precache list is computed, so it is deliberately NOT in the
      // shell — a cached copy would defeat the check; vercel.json serves it
      // no-cache with a permissive CORS header (Electron fetches it from a
      // file:// origin).
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: JSON.stringify({ build: BUILD_ID }),
      });
    },
  };
}

export default defineConfig({
  // Baked into every bundle as `__VELLUM_BUILD__` (see UpdateBanner.tsx).
  define: { __VELLUM_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [react(), appRouteAlias(), vellumPWA()],
  // Relative asset URLs: one dist/ has to work from Electron's
  // file://…/dist/app.html, from "/", from "/app.html" and from "/app".
  // (The one bad case, "/app/", is ruled out by trailingSlash:false in
  // vercel.json — and by the dev alias above.)
  base: "./",
  test: {
    // `_to_delete/` is a gitignored scratch copy whose stale
    // `./_generated/api` import can't resolve. Vitest discovered it and
    // failed the run, so `npx vitest run` reported a failure that had
    // nothing to do with the code — and every fresh audit re-reported it.
    exclude: [...configDefaults.exclude, "_to_delete/**"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // KaTeX is only ever reached through a dynamic import (EquationBlock.tsx).
  // Pre-bundle it up front so the dev server never discovers it late and
  // full-reloads the page in the middle of an e2e run.
  optimizeDeps: { include: ["katex"] },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 4000,
    // Browsers the CSS may assume. Without it the minifier "lowers" the
    // right-to-left rules' `:dir(rtl)` into `:lang(he), :lang(ar)…`, which
    // never matches (the app's lang is en and direction comes from
    // dir="auto"), so RTL mirroring worked in dev and vanished in every
    // build (shipped that way once, 2026-09-23). All four have supported
    // :dir() natively since 2023; Electron's Chromium is far newer.
    cssTarget: ["chrome120", "edge120", "firefox115", "safari16.4"],
    rollupOptions: {
      // Four entries: the marketing landing at "/", the SPA at "/app",
      // the Help Center at "/help" and the legal pages at "/legal".
      input: {
        landing: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
        help: resolve(__dirname, "help.html"),
        legal: resolve(__dirname, "legal.html"),
      },
    },
  },
});
