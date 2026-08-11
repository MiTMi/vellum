import { ConvexReactClient } from "convex/react";
import { FunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { PageDoc, PageId } from "../lib/types";
import { OfflineDb } from "./idb";
import {
  OutboxOp,
  isLocalId,
  mapIdsDeep,
  referencesTempId,
} from "./ops";
import { Outbox } from "./outbox";
import { PageStore } from "./store";

/**
 * The sync engine. Owns the full offline lifecycle:
 *  - boot hydration of the replica + outbox from IndexedDB
 *  - persisting replica changes back to IndexedDB (debounced)
 *  - up-sync: FIFO outbox drain when the WebSocket is connected, with
 *    temp-id → real-id remapping for pages created offline
 *  - down-sync: diffing pages.syncIndex against the replica, pulling stale
 *    docs in batches, deleting pages absent from the index
 *
 * Reconcile only runs when the outbox is empty, so pulled state never
 * tramples queued local writes; a drain is always followed by a reconcile.
 */

export interface SyncIndexEntry {
  _id: string;
  updatedAt: number;
  /** My role on a shared page (absent for owned). Part of the diff key. */
  role?: "viewer" | "editor";
}

/** Injectable transport — production wires to Convex, tests to convex-test. */
export interface SyncTransport {
  fetchSyncIndex(): Promise<SyncIndexEntry[]>;
  fetchDocs(ids: string[]): Promise<PageDoc[]>;
  /** Replay one (already id-mapped) op. Returns the real id for creates. */
  runMutation(op: OutboxOp): Promise<unknown>;
  subscribeSyncIndex(cb: () => void): () => void;
  subscribeConnection(cb: (connected: boolean) => void): () => void;
  isConnected(): boolean;
}

export interface SyncStatus {
  connected: boolean;
  syncing: boolean;
  pending: number;
  /** Ops dropped because the server deterministically rejected them. */
  failed: number;
}

export interface SyncEngine {
  /** Hydrate from IndexedDB and begin syncing. Resolves once hydrated. */
  start(): Promise<void>;
  /** Nudge the engine (called after each local mutation). */
  kick(): void;
  /** Resolves after the first successful reconcile ever (any session). */
  firstSyncDone(): Promise<void>;
  isConnected(): boolean;
  getStatus(): SyncStatus;
  subscribeStatus(cb: () => void): () => void;
  /** Resolves when the current sync pass (if any) finishes. Test helper. */
  idle(): Promise<void>;
  stop(): void;
}

const FETCH_BATCH = 50;

function dispatchAppEvent(name: string, detail?: unknown) {
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

async function withWebLock(name: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    await locks.request(name, fn);
  } else {
    await fn();
  }
}

export interface SyncEngineDeps {
  db: OfflineDb;
  store: PageStore;
  outbox: Outbox;
  transport: SyncTransport;
}

export function createSyncEngine({
  db,
  store,
  outbox,
  transport,
}: SyncEngineDeps): SyncEngine {
  let idMap = new Map<string, string>();
  let everSynced = false;
  let connected = false;
  let syncing = false;
  let syncAgain = false;
  let currentSync: Promise<void> = Promise.resolve();
  let stopped = false;
  let failedOps = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubs: Array<() => void> = [];

  let resolveFirstSync!: () => void;
  const firstSync = new Promise<void>((r) => (resolveFirstSync = r));

  const statusListeners = new Set<() => void>();
  let statusSnapshot: SyncStatus = { connected, syncing, pending: 0, failed: 0 };
  function refreshStatus() {
    const next: SyncStatus = {
      connected,
      syncing,
      pending: outbox.size(),
      failed: failedOps,
    };
    if (
      next.connected !== statusSnapshot.connected ||
      next.syncing !== statusSnapshot.syncing ||
      next.pending !== statusSnapshot.pending ||
      next.failed !== statusSnapshot.failed
    ) {
      statusSnapshot = next;
      for (const l of [...statusListeners]) l();
    }
  }

  /* ------------------------- persistence ------------------------- */

  const dirtyIds = new Set<PageId>();
  const deletedIds = new Set<PageId>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistChain: Promise<void> = Promise.resolve();

  function flushPersist() {
    persistTimer = null;
    const puts: PageDoc[] = [];
    for (const id of dirtyIds) {
      const doc = store.get(id);
      if (doc) puts.push(structuredClone(doc));
    }
    const dels = [...deletedIds];
    dirtyIds.clear();
    deletedIds.clear();
    persistChain = persistChain
      .then(async () => {
        await db.putPages(puts);
        await db.deletePages(dels);
      })
      .catch((err) => console.error("Replica persistence failed:", err));
  }

  function onStoreCommit(changed: PageId[], removed: PageId[]) {
    for (const id of changed) {
      deletedIds.delete(id);
      dirtyIds.add(id);
    }
    for (const id of removed) {
      dirtyIds.delete(id);
      deletedIds.add(id);
    }
    if (!persistTimer) persistTimer = setTimeout(flushPersist, 50);
  }

  /* --------------------------- up-sync --------------------------- */

  function mapOp(op: OutboxOp): OutboxOp {
    const mapped = mapIdsDeep(op, idMap);
    if (mapped.kind === "createWithDoc" && op.kind === "createWithDoc") {
      // clientKey is the idempotency token — it must never be rewritten.
      mapped.clientKey = op.clientKey;
    }
    return mapped;
  }

  /** Swap a temp id for its real id everywhere, in one synchronous turn. */
  function applyRemap(from: string, to: string) {
    // Flush in-flight editor edits under the temp id first, then swap ids
    // in the store and tell the UI — synchronously, so React never renders
    // a frame where the open page doesn't exist.
    dispatchAppEvent("vellum:flush-edits");
    store.remapId(from as PageId, to as PageId);
    dispatchAppEvent("vellum:id-remapped", { from, to });
  }

  async function persistIdMap() {
    // Merge-write: another window sharing this IndexedDB must not have its
    // entries clobbered.
    const saved = (await db.getMeta<Record<string, string>>("idMap")) ?? {};
    for (const [k, v] of idMap) saved[k] = v;
    await db.setMeta("idMap", saved);
  }

  async function drainOutbox(): Promise<void> {
    for (;;) {
      if (!transport.isConnected()) return;
      const stored = outbox.peek();
      if (!stored) return;
      const op = stored.op;
      outbox.markInFlight(stored.seq);
      try {
        if (op.kind === "createWithDoc") {
          const known = idMap.get(op.clientKey);
          if (known !== undefined) {
            // Crash between ack and outbox delete — already replayed. The
            // store may still hold the temp doc; finish the remap now.
            outbox.complete(stored.seq);
            if (store.get(op.clientKey as PageId)) applyRemap(op.clientKey, known);
            continue;
          }
          const mapped = mapOp(op);
          if (referencesTempId(mapped)) {
            // Parent create must have failed — orphan this create at root
            // rather than dropping the user's page.
            if (mapped.kind === "createWithDoc") delete mapped.doc.parentId;
          }
          const realId = String(await transport.runMutation(mapped));
          idMap.set(op.clientKey, realId);
          await persistIdMap();
          outbox.complete(stored.seq);
          applyRemap(op.clientKey, realId);
        } else {
          const mapped = mapOp(op);
          if (referencesTempId(mapped)) {
            console.warn("Dropping op for a page that never synced:", mapped.kind);
            outbox.complete(stored.seq);
            continue;
          }
          await transport.runMutation(mapped);
          outbox.complete(stored.seq);
        }
      } catch (err) {
        // Convex retries transport failures internally, so a rejected
        // mutation is a deterministic server error — retrying would loop
        // forever. Drop the op and keep draining.
        console.warn(`Dropping failed offline op "${op.kind}":`, err);
        failedOps++;
        outbox.complete(stored.seq);
      } finally {
        outbox.clearInFlight();
      }
      refreshStatus();
    }
  }

  /* -------------------------- down-sync -------------------------- */

  async function reconcile(): Promise<void> {
    const entries = await transport.fetchSyncIndex();
    const serverIds = new Set(entries.map((e) => e._id));

    const toFetch = entries
      .filter((e) => {
        const local = store.get(e._id as PageId);
        // Diff on (updatedAt, role): a share-role change never touches the
        // page itself, so comparing updatedAt alone would leave a stale
        // role in the replica until the next real edit.
        return !local || local.updatedAt !== e.updatedAt || local.role !== e.role;
      })
      .map((e) => e._id);

    for (let i = 0; i < toFetch.length; i += FETCH_BATCH) {
      const docs = await transport.fetchDocs(toFetch.slice(i, i + FETCH_BATCH));
      const touched = outbox.touchedIds();
      for (const doc of docs) {
        if (!touched.has(doc._id)) store.applyServerDoc(doc);
      }
    }

    const touched = outbox.touchedIds();
    for (const local of store.all()) {
      if (
        !serverIds.has(local._id) &&
        !isLocalId(local._id) &&
        !touched.has(local._id)
      ) {
        store.removePage(local._id);
      }
    }

    if (!everSynced) {
      everSynced = true;
      await db.setMeta("hasEverSynced", true);
      resolveFirstSync();
    }
  }

  /* ------------------------- orchestration ------------------------ */

  async function syncPass(): Promise<void> {
    await withWebLock("vellum-sync", async () => {
      do {
        syncAgain = false;
        await drainOutbox();
      } while (syncAgain && transport.isConnected());
      if (transport.isConnected() && outbox.isEmpty()) {
        await reconcile();
      }
    });
  }

  function kick() {
    if (stopped || !transport.isConnected()) {
      refreshStatus();
      return;
    }
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    refreshStatus();
    currentSync = (async () => {
      try {
        do {
          syncAgain = false;
          await syncPass();
        } while (syncAgain);
      } catch (err) {
        console.warn("Sync pass failed, retrying shortly:", err);
        if (!retryTimer && !stopped) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            kick();
          }, 5000);
        }
      } finally {
        syncing = false;
        refreshStatus();
      }
    })();
  }

  return {
    async start() {
      const [docs, savedMap, savedSynced] = await Promise.all([
        db.loadPages(),
        db.getMeta<Record<string, string>>("idMap"),
        db.getMeta<boolean>("hasEverSynced"),
      ]);
      store.load(docs);
      idMap = new Map(Object.entries(savedMap ?? {}));
      everSynced = savedSynced === true;
      if (everSynced) resolveFirstSync();

      store.setOnCommit(onStoreCommit);

      // Crash-recovery sweep: a temp page whose create was acked (idMap has
      // it) but whose remapped replica never persisted would otherwise live
      // on as a permanent unsyncable ghost next to the real page.
      for (const doc of store.all()) {
        if (!isLocalId(doc._id)) continue;
        const real = idMap.get(doc._id);
        if (!real) continue;
        if (store.get(real as PageId)) store.removePage(doc._id);
        else store.remapId(doc._id, real as PageId);
      }
      connected = transport.isConnected();
      unsubs.push(
        transport.subscribeConnection((isUp) => {
          connected = isUp;
          refreshStatus();
          if (isUp) kick();
        }),
        transport.subscribeSyncIndex(() => kick()),
        outbox.subscribe(refreshStatus),
      );
      refreshStatus();
      if (connected) kick();
    },

    kick,
    firstSyncDone: () => firstSync,
    isConnected: () => connected,
    getStatus: () => statusSnapshot,
    subscribeStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    idle: () => currentSync,
    stop() {
      stopped = true;
      for (const u of unsubs) u();
      unsubs.length = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (persistTimer) {
        clearTimeout(persistTimer);
        flushPersist();
      }
    },
  };
}

/* ------------------------ production transport ------------------------ */

/**
 * Map an (id-mapped) outbox op to its Convex mutation reference + args.
 * Shared by the production transport and the test transport so both replay
 * ops identically.
 */
export function opToMutationCall(
  op: OutboxOp,
): [FunctionReference<"mutation">, Record<string, unknown>] {
  const [ref, args] = rawMutationCall(op);
  // Optional fields land here as explicit `undefined` — strip them so args
  // validate identically through every transport.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) clean[k] = v;
  }
  return [ref, clean];
}

function rawMutationCall(
  op: OutboxOp,
): [FunctionReference<"mutation">, Record<string, unknown>] {
  switch (op.kind) {
    case "createWithDoc":
      return [
        api.pages.createWithDoc,
        { ...op.doc, clientKey: op.clientKey },
      ];
    case "rename":
      return [
        api.pages.rename,
        { id: op.id, title: op.title, clientUpdatedAt: op.clientUpdatedAt },
      ];
    case "updateContent":
      return [
        api.pages.updateContent,
        {
          id: op.id,
          content: op.content,
          text: op.text,
          clientUpdatedAt: op.clientUpdatedAt,
        },
      ];
    case "setIcon":
      return [api.pages.setIcon, { id: op.id, icon: op.icon }];
    case "setCover":
      return [api.pages.setCover, { id: op.id, cover: op.cover }];
    case "setFavorite":
      return [api.pages.toggleFavorite, { id: op.id, value: op.value }];
    case "setTemplate":
      return [api.pages.setTemplate, { id: op.id, value: op.value }];
    case "setPageOptions":
      return [
        api.pages.setPageOptions,
        {
          id: op.id,
          font: op.font,
          smallText: op.smallText,
          fullWidth: op.fullWidth,
          locked: op.locked,
        },
      ];
    case "move":
      return [
        api.pages.move,
        { id: op.id, parentId: op.parentId, rank: op.rank },
      ];
    case "trash":
      return [api.pages.trash, { id: op.id }];
    case "restore":
      return [api.pages.restore, { id: op.id }];
    case "deleteForever":
      return [api.pages.deleteForever, { id: op.id }];
    case "emptyTrash":
      return [api.pages.emptyTrash, {}];
    case "updateDbProps":
      return [api.pages.updateDbProps, { id: op.id, dbProps: op.dbProps }];
    case "setRowProp":
      return [
        api.pages.setRowProp,
        { id: op.id, propId: op.propId, value: op.value },
      ];
    case "setView":
      return [
        api.pages.setView,
        {
          id: op.id,
          activeView: op.activeView,
          boardGroupBy: op.boardGroupBy,
          calendarBy: op.calendarBy,
        },
      ];
    case "setViews":
      return [api.pages.setViews, { id: op.id, views: op.views }];
  }
}

export function createConvexTransport(client: ConvexReactClient): SyncTransport {
  return {
    fetchSyncIndex: () => client.query(api.pages.syncIndex, {}),
    fetchDocs: (ids) =>
      client.query(api.pages.getMany, {
        ids: ids as Id<"pages">[],
      }) as Promise<PageDoc[]>,
    runMutation(op) {
      const [ref, args] = opToMutationCall(op);
      return client.mutation(ref, args as never);
    },
    subscribeSyncIndex(cb) {
      const watch = client.watchQuery(api.pages.syncIndex, {});
      return watch.onUpdate(cb);
    },
    subscribeConnection(cb) {
      const unsubscribe = client.subscribeToConnectionState((state) =>
        cb(state.isWebSocketConnected && browserOnline()),
      );
      // The WebSocket can linger "connected" for a while after the network
      // drops (until a heartbeat fails) — navigator.onLine flips instantly.
      const onNetChange = () =>
        cb(client.connectionState().isWebSocketConnected && browserOnline());
      if (typeof window !== "undefined") {
        window.addEventListener("online", onNetChange);
        window.addEventListener("offline", onNetChange);
      }
      return () => {
        unsubscribe();
        if (typeof window !== "undefined") {
          window.removeEventListener("online", onNetChange);
          window.removeEventListener("offline", onNetChange);
        }
      };
    },
    isConnected: () =>
      client.connectionState().isWebSocketConnected && browserOnline(),
  };
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}
