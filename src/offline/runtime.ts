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
    transport: createConvexTransport(convex),
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
