import { PageDoc, PageId } from "../lib/types";
import { OutboxOp, StoredOp } from "./ops";

/**
 * Durable local storage for the offline layer: the page replica, the write
 * outbox, and sync metadata (id map, hasEverSynced). Backed by IndexedDB in
 * the app; `createMemoryDb` provides the same contract for tests.
 */
export interface OfflineDb {
  loadPages(): Promise<PageDoc[]>;
  putPages(docs: PageDoc[]): Promise<void>;
  deletePages(ids: PageId[]): Promise<void>;
  loadOps(): Promise<StoredOp[]>;
  addOp(seq: number, op: OutboxOp): Promise<void>;
  putOp(seq: number, op: OutboxOp): Promise<void>;
  deleteOp(seq: number): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

const DB_NAME = "vellum-offline";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pages")) {
        db.createObjectStore("pages", { keyPath: "_id" });
      }
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB tx aborted"));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openOfflineDb(): Promise<OfflineDb> {
  const db = await openDatabase();
  return {
    async loadPages() {
      const tx = db.transaction("pages", "readonly");
      return (await reqResult(tx.objectStore("pages").getAll())) as PageDoc[];
    },
    async putPages(docs) {
      if (!docs.length) return;
      const tx = db.transaction("pages", "readwrite");
      const store = tx.objectStore("pages");
      for (const doc of docs) store.put(doc);
      await txDone(tx);
    },
    async deletePages(ids) {
      if (!ids.length) return;
      const tx = db.transaction("pages", "readwrite");
      const store = tx.objectStore("pages");
      for (const id of ids) store.delete(id);
      await txDone(tx);
    },
    async loadOps() {
      const tx = db.transaction("outbox", "readonly");
      const store = tx.objectStore("outbox");
      const [keys, values] = await Promise.all([
        reqResult(store.getAllKeys()),
        reqResult(store.getAll()),
      ]);
      return keys
        .map((key, i) => ({ seq: key as number, op: values[i] as OutboxOp }))
        .sort((a, b) => a.seq - b.seq);
    },
    async addOp(seq, op) {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").add(op, seq);
      await txDone(tx);
    },
    async putOp(seq, op) {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put(op, seq);
      await txDone(tx);
    },
    async deleteOp(seq) {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").delete(seq);
      await txDone(tx);
    },
    async getMeta<T>(key: string) {
      const tx = db.transaction("meta", "readonly");
      return (await reqResult(tx.objectStore("meta").get(key))) as T | undefined;
    },
    async setMeta(key, value) {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(value, key);
      await txDone(tx);
    },
  };
}

/** In-memory OfflineDb for tests (and as a fallback if IndexedDB is broken). */
export function createMemoryDb(): OfflineDb {
  const pages = new Map<string, PageDoc>();
  const outbox = new Map<number, OutboxOp>();
  const meta = new Map<string, unknown>();
  return {
    async loadPages() {
      return [...pages.values()].map((d) => structuredClone(d));
    },
    async putPages(docs) {
      for (const doc of docs) pages.set(doc._id, structuredClone(doc));
    },
    async deletePages(ids) {
      for (const id of ids) pages.delete(id);
    },
    async loadOps() {
      return [...outbox.entries()]
        .map(([seq, op]) => ({ seq, op: structuredClone(op) }))
        .sort((a, b) => a.seq - b.seq);
    },
    async addOp(seq, op) {
      outbox.set(seq, structuredClone(op));
    },
    async putOp(seq, op) {
      outbox.set(seq, structuredClone(op));
    },
    async deleteOp(seq) {
      outbox.delete(seq);
    },
    async getMeta<T>(key: string) {
      return meta.get(key) as T | undefined;
    },
    async setMeta(key, value) {
      meta.set(key, structuredClone(value));
    },
  };
}
