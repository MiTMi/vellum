import { OfflineDb } from "./idb";
import {
  OutboxOp,
  StoredOp,
  coalesceKey,
  mergeOps,
  opPageId,
} from "./ops";

/**
 * Durable FIFO write queue. The in-memory array is authoritative for
 * ordering; every change is mirrored to IndexedDB through a serialized
 * write chain so the on-disk queue is always a valid prefix-consistent
 * copy. Consecutive absolute-value ops for the same page coalesce so an
 * offline editing session replays as a handful of mutations.
 */
export interface Outbox {
  size(): number;
  isEmpty(): boolean;
  peek(): StoredOp | undefined;
  list(): StoredOp[];
  enqueue(op: OutboxOp): void;
  /** Remove the op with this seq (after successful replay). */
  complete(seq: number): void;
  /**
   * Drop every op about a page created offline whose create is still queued
   * (the page never reached the server, so nothing needs replaying).
   * Returns true if the queued create was found and dropped.
   */
  dropOpsForUnsyncedCreate(clientKey: string): boolean;
  /** Ids of pages any queued op still touches (blocks server overwrites). */
  touchedIds(): Set<string>;
  /**
   * Mark/clear the op currently being replayed. While an op is in flight it
   * must not be coalesced into (its content is already on the wire — a merge
   * would be deleted unsent on ack) nor dropped by
   * dropOpsForUnsyncedCreate (the server may already have applied it).
   */
  markInFlight(seq: number): void;
  clearInFlight(): void;
  /** Resolves when all IDB mirror writes issued so far have settled. */
  flushed(): Promise<void>;
  subscribe(cb: () => void): () => void;
}

export async function createOutbox(db: OfflineDb): Promise<Outbox> {
  const ops: StoredOp[] = await db.loadOps();
  let nextSeq = ops.reduce((m, o) => Math.max(m, o.seq), 0) + 1;
  let inFlight: number | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  function notify() {
    for (const l of [...listeners]) l();
  }

  function mirror(fn: () => Promise<void>) {
    writeChain = writeChain.then(fn).catch((err) => {
      console.error("Outbox persistence failed:", err);
    });
  }

  return {
    size: () => ops.length,
    isEmpty: () => ops.length === 0,
    peek: () => ops[0],
    list: () => [...ops],

    enqueue(op) {
      const key = coalesceKey(op);
      if (key) {
        for (let i = ops.length - 1; i >= 0; i--) {
          // Never coalesce past an order-sensitive op (create/trash/…):
          // merging would move this op's effect to before the barrier —
          // e.g. a move into a page whose create hasn't replayed yet.
          const candidateKey = coalesceKey(ops[i].op);
          if (candidateKey === null) break;
          if (candidateKey === key && ops[i].seq !== inFlight) {
            const merged = mergeOps(ops[i].op, op);
            ops[i] = { seq: ops[i].seq, op: merged };
            const seq = ops[i].seq;
            mirror(() => db.putOp(seq, merged));
            notify();
            return;
          }
        }
      }
      const stored: StoredOp = { seq: nextSeq++, op };
      ops.push(stored);
      mirror(() => db.addOp(stored.seq, stored.op));
      notify();
    },

    complete(seq) {
      const idx = ops.findIndex((o) => o.seq === seq);
      if (idx !== -1) ops.splice(idx, 1);
      mirror(() => db.deleteOp(seq));
      notify();
    },

    dropOpsForUnsyncedCreate(clientKey) {
      const create = ops.find(
        (o) => o.op.kind === "createWithDoc" && o.op.clientKey === clientKey,
      );
      // An in-flight create may already exist server-side — the caller must
      // send a real delete instead of dropping the queue.
      if (!create || create.seq === inFlight) return false;
      const dropped = ops.filter((o) => opPageId(o.op) === clientKey);
      for (const d of dropped) {
        const idx = ops.indexOf(d);
        if (idx !== -1) ops.splice(idx, 1);
        mirror(() => db.deleteOp(d.seq));
      }
      notify();
      return true;
    },

    touchedIds() {
      const out = new Set<string>();
      for (const o of ops) {
        const id = opPageId(o.op);
        if (id) out.add(id);
      }
      return out;
    },

    markInFlight(seq) {
      inFlight = seq;
    },
    clearInFlight() {
      inFlight = null;
    },

    flushed() {
      return writeChain;
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
