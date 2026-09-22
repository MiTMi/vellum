import { useSyncExternalStore } from "react";

/**
 * The terminal state of a code-split surface whose chunk failed to load.
 *
 * A failed dynamic import is memoized by the browser's module map, so
 * retrying the same `import()` never refetches (lib/lazyModule.ts) — the
 * only recovery is a reload, so that is the one affordance offered. Pending
 * edits are flushed first, the same sequence main.tsx's stale-deploy
 * handler uses.
 *
 * Offline the button is disabled: a first-visit tab whose service worker
 * never installed can still work from the IndexedDB replica, and a reload
 * there would trade a missing database view for the browser's error page.
 */
const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
const readOnline = () => navigator.onLine;

export default function ChunkFailed({ title }: { title: string }) {
  const online = useSyncExternalStore(subscribeOnline, readOnline, () => true);
  return (
    <div className="page-missing">
      <h2>{title}</h2>
      <p>
        {online
          ? "Part of Vellum failed to download. Reload to try again."
          : "Part of Vellum hasn’t been downloaded yet. Reload once you’re back online."}
      </p>
      <button
        className="btn primary"
        disabled={!online}
        onClick={() => {
          window.dispatchEvent(new Event("vellum:flush-edits"));
          window.location.reload();
        }}
      >
        Reload
      </button>
    </div>
  );
}
