/**
 * Warm a code-split chunk in the background: run `load` (an `import()`
 * thunk) once the app has settled — a couple of seconds after boot, then at
 * the browser's next idle moment. Deliberately not "as soon as idle": right
 * after first paint the main thread is busy mounting the editor, and parsing
 * a few hundred kB there competes with the first keystrokes. A surface that
 * is needed sooner still loads on demand; this only makes the common case —
 * someone opens it a while later — find the chunk already resident.
 * Failures are swallowed here: the on-demand path reports them.
 */

let inFlight = 0;

/**
 * True while a background warm-up import is pending. Vite dispatches
 * `vite:preloadError` inside the import's promise chain, before any caller's
 * `.catch` runs, so main.tsx's handler consults this to avoid reloading the
 * whole tab over a failure nobody on screen asked for.
 */
export const isWarming = () => inFlight > 0;

export function warmChunk(load: () => Promise<unknown>, delayMs = 2500) {
  if (typeof window === "undefined") return;
  const run = () => {
    inFlight++;
    void load()
      .catch(() => {})
      .finally(() => {
        inFlight--;
      });
  };
  setTimeout(() => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(run);
    else run();
  }, delayMs);
}
