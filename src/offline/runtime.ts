import { useSyncExternalStore } from "react";
import { ConvexReactClient } from "convex/react";
import { createMemoryDb, openOfflineDb, OfflineDb } from "./idb";
import { createOutbox, Outbox } from "./outbox";
import { createPageStore, PageStore } from "./store";
import {
  createConvexTransport,
  createSyncEngine,
  SyncEngine,
  SyncStatus,
  SyncTransport,
} from "./sync";

/**
 * App-level singletons for the offline layer. The store exists from module
 * load (so data hooks can bind to it); the outbox and engine come up in
 * initOfflineRuntime, which main.tsx awaits before rendering the app.
 */

const store = createPageStore();
let outbox: Outbox | null = null;
let engine: SyncEngine | null = null;
let client: ConvexReactClient | null = null;

export function offlineStore(): PageStore {
  return store;
}

export function offlineOutbox(): Outbox {
  if (!outbox) throw new Error("Offline runtime not initialized");
  return outbox;
}

export function offlineEngine(): SyncEngine {
  if (!engine) throw new Error("Offline runtime not initialized");
  return engine;
}

export function convexClient(): ConvexReactClient {
  if (!client) throw new Error("Offline runtime not initialized");
  return client;
}

/**
 * Auth gate over the transport. The engine must never talk to the server
 * before Convex Auth has confirmed an identity: drainOutbox treats any
 * rejected mutation as a deterministic server error and DROPS the op, so
 * draining while "Not authenticated" would silently discard queued edits.
 * Until the gate opens the transport simply reports "disconnected" — the
 * same state the engine already handles for a network outage.
 */
let syncAuthorized = false;
let gateChanged: (() => void) | null = null;

export function setSyncAuthorized(ok: boolean): void {
  if (ok === syncAuthorized) return;
  syncAuthorized = ok;
  gateChanged?.();
}

function gateTransport(inner: SyncTransport): SyncTransport {
  const connListeners = new Set<(up: boolean) => void>();
  const pendingWatches = new Set<() => void>();
  const up = () => syncAuthorized && inner.isConnected();
  gateChanged = () => {
    for (const attach of [...pendingWatches]) attach();
    for (const cb of connListeners) cb(up());
  };
  return {
    ...inner,
    isConnected: up,
    subscribeConnection(cb) {
      connListeners.add(cb);
      const unsub = inner.subscribeConnection(() => cb(up()));
      return () => {
        connListeners.delete(cb);
        unsub();
      };
    },
    // The server-side watch is deferred too — a pre-auth subscription just
    // streams "Not authenticated" errors at the console.
    subscribeSyncIndex(cb) {
      let unsub: (() => void) | null = null;
      const attach = () => {
        if (!unsub && syncAuthorized) {
          pendingWatches.delete(attach);
          unsub = inner.subscribeSyncIndex(cb);
        }
      };
      if (syncAuthorized) attach();
      else pendingWatches.add(attach);
      return () => {
        pendingWatches.delete(attach);
        if (unsub) unsub();
        unsub = null;
      };
    },
  };
}

export async function initOfflineRuntime(
  convex: ConvexReactClient,
): Promise<void> {
  client = convex;
  let db: OfflineDb;
  try {
    db = await openOfflineDb();
  } catch (err) {
    console.error(
      "IndexedDB unavailable — offline changes won't survive restarts:",
      err,
    );
    db = createMemoryDb();
  }
  outbox = await createOutbox(db);
  engine = createSyncEngine({
    db,
    store,
    outbox,
    transport: gateTransport(createConvexTransport(convex)),
  });
  await engine.start();
}

const IDLE_STATUS: SyncStatus = {
  connected: false,
  syncing: false,
  pending: 0,
  failed: 0,
};

/** Live sync status for UI (safe to call before init / in mock mode). */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (cb) => (engine ? engine.subscribeStatus(cb) : () => {}),
    () => (engine ? engine.getStatus() : IDLE_STATUS),
  );
}
