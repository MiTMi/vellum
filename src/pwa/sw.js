/* eslint-disable no-undef */
/**
 * Vellum's service worker — hand-rolled, deliberately small.
 *
 * Its only job is to make the app *shell* bootable offline. The workspace's
 * own data already lives in an IndexedDB replica (src/offline/), so once the
 * shell loads the app is fully usable with no network at all.
 *
 * Two placeholders below are replaced at build time by the vellum-pwa plugin
 * in vite.config.ts: __CACHE_NAME__ (content-hashed, so a new build evicts the
 * old cache) and __PRECACHE__ (the shell's file list).
 *
 * Hard rules, in order of how much damage breaking them would do:
 *  1. Never touch cross-origin requests. Convex traffic (*.convex.cloud /
 *     *.convex.site — websocket, HTTP actions, file storage) must reach the
 *     network untouched, and a stale cached mutation response would be a
 *     correctness bug, not a performance one.
 *  2. Never touch /p/* — published pages are server-rendered and proxied; a
 *     cached copy could outlive an unpublish, which is a privacy leak.
 *  3. Never cache non-GET.
 */

const CACHE = "__CACHE_NAME__";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * The shell entry a navigation should fall back to when the network is gone.
 * Root-absolute, and the *canonical* URL rather than the file on disk — the
 * host serves app.html at /app and 308s /app.html to it, so /app is what the
 * precache is keyed by. The worker only ever runs on the hosted origin (never
 * inside Electron), so there is no relative-base problem to solve.
 */
function offlineFallbackFor(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "/";
  // The Help Center is its own precached entry: offline, "how do I…?" should
  // answer itself rather than dumping the reader into the workspace.
  if (pathname === "/help" || pathname === "/help.html") return "/help";
  return "/app";
}

/**
 * Answer a navigation from cache.
 *
 * The response is rebuilt rather than returned as-is: navigation requests
 * carry redirect:"manual", and handing one a response whose `redirected` flag
 * is set makes the whole navigation fail. That flag is easy to acquire by
 * accident (any host that redirects the cached URL), so strip it here instead
 * of relying on the precache list never picking one up.
 */
async function cachedShell(pathname) {
  const hit = await caches.match(offlineFallbackFor(pathname), {
    ignoreSearch: true,
  });
  if (!hit) return Response.error();
  return new Response(hit.body, {
    status: 200,
    statusText: "OK",
    headers: hit.headers,
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Rule 1: cross-origin is none of our business (this is what keeps every
  // Convex request off the service worker's hands).
  if (url.origin !== self.location.origin) return;
  // Rule 2: published pages are proxied to Convex and must never be cached.
  if (url.pathname === "/p" || url.pathname.startsWith("/p/")) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => cachedShell(url.pathname)));
    return;
  }

  // Build assets are content-hashed, so a hit is always correct.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Everything else (icons, manifest, favicon): fresh if possible, cached if not.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
