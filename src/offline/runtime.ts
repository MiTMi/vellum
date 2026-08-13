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

let openDb: OfflineDb | null = null;

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
  openDb = db;
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

/** The IndexedDB database holding this device's replica and outbox. */
export const OFFLINE_DB_NAME = "vellum-offline";

/** Queued writes that have not reached the server yet, 0 if there's no
 *  runtime (mock mode, or direct-Convex mode with no offline layer). */
export function pendingWriteCount(): number {
  return outbox?.size() ?? 0;
}

/**
 * Erase this device's local workspace: the replica, the outbox, and the
 * sync engine holding them.
 *
 * Sign-out has to do this. The database name is one global constant, not
 * per-user, so on a shared device the next person to sign in opens the
 * previous user's replica — their page titles are on screen until reconcile
 * catches up — and inherits their queued outbox, where a root-level create
 * would replay under the new identity and be stamped with the new
 * `ownerId`. That was harmless while Vellum was single-user; Phase 1
 * multi-tenancy made it a cross-account path.
 *
 * The engine is stopped first so nothing writes the database back after the
 * delete, and the caller is expected to reload immediately afterwards.
 */
export async function clearLocalWorkspace(): Promise<void> {
  engine?.stop();
  engine = null;
  outbox = null;
  // Close before deleting: an open connection blocks deleteDatabase.
  openDb?.close();
  openDb = null;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      const req = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = finish;
      // `onblocked` fires when another tab still holds the database open and
      // never resolves on its own. Signing out must not hang on that — the
      // reload that follows closes this tab's handle either way.
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  });
}
