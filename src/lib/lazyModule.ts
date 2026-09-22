import { useEffect, useSyncExternalStore } from "react";

/**
 * A code-split module the UI can wait for WITHOUT React.lazy/Suspense.
 *
 * Why not Suspense: once a boundary has shown its fallback, React holds the
 * real content back until 300 ms have passed (its anti-flicker throttle).
 * Measured on this app with a Suspense boundary around the page body, that
 * turned a 120 ms first paint of the open page into ~390 ms, for a chunk
 * that had arrived after 40. Here the arrival is
 * an ordinary store update, so the content renders the moment the chunk
 * does — and there is no suspended subtree to reason about, and no error
 * boundary needed: a failed load is just `failed: true`.
 *
 * `load()` is idempotent and safe to call early (boot, hover) to warm the
 * chunk. A failed load is TERMINAL for this document: the browser records
 * a failed module fetch in its module map, so re-running the same `import()`
 * rejects again without touching the network. `failed` therefore stays
 * sticky and the only recovery is a reload, which the failed surfaces offer
 * (components/ChunkFailed.tsx). Offline, chunks come from the service
 * worker's precache, which holds every emitted file.
 */
export interface LazyModule<T> {
  load(): Promise<void>;
  /** The module's default export once loaded, else null. Not a hook. */
  get(): T | null;
  /** Subscribe a component; starts the load while `wanted`. */
  use(wanted?: boolean): { value: T | null; failed: boolean };
}

export function lazyModule<T>(
  importer: () => Promise<{ default: T }>,
): LazyModule<T> {
  let snapshot: { value: T | null; failed: boolean } = {
    value: null,
    failed: false,
  };
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: typeof snapshot) => {
    snapshot = next;
    listeners.forEach((l) => l());
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const getSnapshot = () => snapshot;

  const load = () => {
    if (snapshot.value) return Promise.resolve();
    return (pending ??= importer()
      .then((m) => publish({ value: m.default, failed: false }))
      .catch((err) => {
        console.error("[vellum] code-split chunk failed to load", err);
        publish({ value: null, failed: true });
      }));
  };

  return {
    load,
    get: () => snapshot.value,
    use(wanted = true) {
      const snap = useSyncExternalStore(subscribe, getSnapshot);
      useEffect(() => {
        if (wanted) void load();
      }, [wanted]);
      return snap;
    },
  };
}
