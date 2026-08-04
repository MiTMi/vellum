/**
 * Service-worker registration. Called from both entries (main.tsx and
 * landing.ts) so an install from either page primes the same shell cache.
 *
 * Three guards, all of them load-bearing:
 *  - PROD only: `dist/sw.js` is emitted by the build, so there is nothing to
 *    register against the dev server.
 *  - Feature-detected: no service worker on `file://`, or in a browser
 *    without one.
 *  - Never inside Electron: the desktop app loads `file://…/dist/app.html`
 *    and has no origin to scope a worker to. Registering there would at best
 *    do nothing and at worst put a cache in front of the packaged renderer.
 */
export function registerSW(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (window.vellum?.isElectron) return;
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") {
    return;
  }

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A failed registration must never break the app — it just means no
      // offline shell on this visit.
    });
  });
}
