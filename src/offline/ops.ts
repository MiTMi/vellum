import { DbProp, DbView, PageDoc, PageId, ViewKind } from "../lib/types";

/**
 * Outbox operations — the durable record of every local write made while
 * (possibly) offline, replayed against Convex in FIFO order on reconnect.
 *
 * All ops carry absolute values (never deltas) so replaying them is
 * idempotent; `createWithDoc` is made idempotent server-side via clientKey.
 */

export const LOCAL_ID_PREFIX = "local_";

export function newLocalId(): PageId {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return (LOCAL_ID_PREFIX + rand) as PageId;
}

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** Doc payload for pages.createWithDoc (PageDoc minus system/sync fields). */
export type CreateDocPayload = Omit<PageDoc, "_id" | "_creationTime">;

export function toCreatePayload(doc: PageDoc): CreateDocPayload {
  const { _id, _creationTime, ...rest } = doc;
  // Docs pulled from the server carry sync-internal fields the PageDoc type
  // doesn't know about; createWithDoc's validator rejects them.
  delete (rest as Record<string, unknown>).contentUpdatedAt;
  delete (rest as Record<string, unknown>).clientKey;
  // Publishing is server-authoritative — the slug is minted by the server
  // and grants public access, so it must never ride along on a create.
  delete (rest as Record<string, unknown>).publicSlug;
  delete (rest as Record<string, unknown>).publishedAt;
  // Share role is a server-stamped, viewer-relative annotation, not page
  // data — and only pages I own are ever replayed as creates.
  delete (rest as Record<string, unknown>).role;
  return rest;
}

export type OutboxOp =
  | { kind: "createWithDoc"; clientKey: string; doc: CreateDocPayload }
  | { kind: "rename"; id: string; title: string; clientUpdatedAt: number }
  | {
      kind: "updateContent";
      id: string;
      content: unknown;
      text: string;
      clientUpdatedAt: number;
    }
  | { kind: "setIcon"; id: string; icon: string | null }
  | { kind: "setCover"; id: string; cover: string | null }
  | { kind: "setFavorite"; id: string; value: boolean }
  | { kind: "setTemplate"; id: string; value: boolean }
  | {
      kind: "setPageOptions";
      id: string;
      font?: "default" | "serif" | "mono";
      smallText?: boolean;
      fullWidth?: boolean;
      locked?: boolean;
    }
  | { kind: "move"; id: string; parentId?: string; rank: number }
  | { kind: "trash"; id: string }
  | { kind: "restore"; id: string }
  | { kind: "deleteForever"; id: string }
  | { kind: "emptyTrash" }
  | { kind: "updateDbProps"; id: string; dbProps: DbProp[] }
  | { kind: "setRowProp"; id: string; propId: string; value: unknown }
  | {
      kind: "setView";
      id: string;
      activeView?: ViewKind;
      boardGroupBy?: string;
      calendarBy?: string;
    }
  | { kind: "setViews"; id: string; views: DbView[] };

export interface StoredOp {
  seq: number;
  op: OutboxOp;
}

/**
 * Ops with the same key collapse to the latest value — an hour of offline
 * typing must replay as one mutation, not thousands. Order-sensitive ops
 * (create/trash/restore/delete) never coalesce.
 */
export function coalesceKey(op: OutboxOp): string | null {
  switch (op.kind) {
    case "rename":
    case "updateContent":
    case "setIcon":
    case "setCover":
    case "setFavorite":
    case "setTemplate":
    case "setPageOptions":
    case "move":
    case "updateDbProps":
    case "setView":
    case "setViews":
      return `${op.kind}:${op.id}`;
    case "setRowProp":
      return `setRowProp:${op.id}:${op.propId}`;
    default:
      return null;
  }
}

/**
 * Ops that carry a client timestamp the server compares against the page's
 * `contentUpdatedAt` (see `lwwStamps` in convex/pages.ts).
 *
 * They coalesce under *separate* keys but share ONE clock, so reordering
 * them past each other is silent data loss: a rename stamped t3 merged in
 * front of a content op stamped t2 replays first, sets contentUpdatedAt to
 * t3, and the content op then loses the comparison and returns success
 * without writing. The local `updatedAt` ends at t3 too, so reconcile sees
 * no difference and never re-pushes — the body text lives on that one
 * device and nowhere else.
 */
export function isStampedOp(op: OutboxOp): boolean {
  return op.kind === "rename" || op.kind === "updateContent";
}

/** Merge a newer coalescible op into an older one with the same key. */
export function mergeOps(prev: OutboxOp, next: OutboxOp): OutboxOp {
  if (
    (prev.kind === "setPageOptions" && next.kind === "setPageOptions") ||
    (prev.kind === "setView" && next.kind === "setView")
  ) {
    return { ...prev, ...next };
  }
  return next;
}

/** The page id this op is "about" (its clientKey for creates). */
export function opPageId(op: OutboxOp): string | null {
  if (op.kind === "createWithDoc") return op.clientKey;
  if (op.kind === "emptyTrash") return null;
  return op.id;
}

/**
 * Deep-clone `value`, replacing every string that exactly matches a temp id
 * in `idMap` with its real Convex id. Temp ids are long random strings, so
 * exact-match replacement anywhere (parentId, pageLink props in content, …)
 * is safe.
 */
export function mapIdsDeep<T>(value: T, idMap: Map<string, string>): T {
  if (idMap.size === 0) return structuredClone(value);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return idMap.get(node) ?? node;
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(structuredClone(value)) as T;
}

/**
 * After id-mapping, does this op still reference an unsynced temp page id?
 *
 * Only *structural* references count (the op's own page, a move's parent, a
 * create's parent). Temp ids appearing in relation property values or in a
 * relation column's targetId deliberately do not block a drain: FIFO
 * guarantees the referenced page's create replays first, so mapIdsDeep has
 * already rewritten them by the time this op is sent.
 */
export function referencesTempId(op: OutboxOp): boolean {
  if (op.kind === "emptyTrash") return false;
  if (op.kind === "createWithDoc") {
    return op.doc.parentId !== undefined && isLocalId(op.doc.parentId);
  }
  if (isLocalId(op.id)) return true;
  if (op.kind === "move" && op.parentId && isLocalId(op.parentId)) return true;
  return false;
}
