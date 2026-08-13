import { PAGE_REF_TYPES } from "../../convex/lib/pageLinks";
import { DbProp, DbView, PageDoc, PageId, ViewKind } from "../lib/types";

/**
 * The local page replica: a Map of full page docs plus every mutation the
 * app supports, mirroring convex/pages.ts semantics exactly. This is the
 * single reducer behind both mock mode (persisted to localStorage) and the
 * offline layer (persisted to IndexedDB, synced to Convex).
 *
 * Mutations take explicit `id` / `now` inputs so callers control identity
 * and time (temp ids offline, deterministic values in tests).
 */

export interface CreateArgs {
  parentId?: PageId;
  type: "doc" | "database";
  title?: string;
  icon?: string;
  props?: Record<string, unknown>;
  /** Creating the vault root itself. Children inherit from their parent. */
  vault?: boolean;
}

export type CommitListener = (changed: PageId[], removed: PageId[]) => void;

export const DEFAULT_DB_PROPS: DbProp[] = [
  {
    id: "status",
    name: "Status",
    type: "select",
    options: [
      { id: "todo", name: "Not started", color: "gray" },
      { id: "doing", name: "In progress", color: "blue" },
      { id: "done", name: "Done", color: "green" },
    ],
  },
  { id: "tags", name: "Tags", type: "multiSelect", options: [] },
  { id: "date", name: "Date", type: "date" },
];

export const WELCOME_CONTENT: unknown[] = [
  { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Your workspace, your rules", styles: {} }] },
  { type: "paragraph", content: [{ type: "text", text: "Vellum is your personal Notion-style workspace. Everything you write is saved instantly — and it works offline too.", styles: {} }] },
  { type: "paragraph", content: [] },
  { type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Things to try", styles: {} }] },
  { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Type ", styles: {} }, { type: "text", text: "/", styles: { code: true } }, { type: "text", text: " anywhere to insert headings, tables, images, and more", styles: {} }] },
  { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Press ", styles: {} }, { type: "text", text: "⌘K", styles: { code: true } }, { type: "text", text: " to search and jump between pages", styles: {} }] },
  { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Hover the page title to add an icon or a cover", styles: {} }] },
  { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Create a database from the sidebar — tables and boards included", styles: {} }] },
  { type: "paragraph", content: [] },
  { type: "quote", content: [{ type: "text", text: "Drag pages in the sidebar to nest them, star the ones you love, and everything else works the way you'd expect.", styles: {} }] },
];

/**
 * Rewrite page references (pageLink blocks, inline pageMention chips)
 * pointing at `from` to point at `to`. Shares PAGE_REF_TYPES with the
 * backlink extractor so a new reference type can't be added to one and
 * forgotten in the other.
 */
function rewriteContentIds(node: unknown, from: string, to: string): boolean {
  let changed = false;
  if (Array.isArray(node)) {
    for (const child of node) {
      if (rewriteContentIds(child, from, to)) changed = true;
    }
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const props = obj.props as Record<string, unknown> | undefined;
    if (
      typeof obj.type === "string" &&
      PAGE_REF_TYPES.includes(obj.type) &&
      props &&
      props.pageId === from
    ) {
      props.pageId = to;
      changed = true;
    }
    for (const value of Object.values(obj)) {
      if (rewriteContentIds(value, from, to)) changed = true;
    }
  }
  return changed;
}

/**
 * Rewrite every string exactly equal to `from` inside a property-value tree
 * (relation values are arrays of page ids). Temp ids are long random
 * strings, so exact-match replacement anywhere is safe — the same argument
 * mapIdsDeep makes for outbox ops.
 */
function rewriteValueIds(node: unknown, from: string, to: string): unknown {
  if (node === from) return to;
  if (Array.isArray(node)) return node.map((n) => rewriteValueIds(n, from, to));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = rewriteValueIds(v, from, to);
    }
    return out;
  }
  return node;
}

export interface DuplicateOptions {
  parentId?: PageId;
  suffix?: string;
  asInstance?: boolean;
  toRoot?: boolean;
}

export interface PageStore {
  get(id: PageId): PageDoc | undefined;
  all(): PageDoc[];
  size(): number;
  version(): number;
  subscribe(cb: () => void): () => void;
  /** Persistence hook — called once per commit with changed/removed ids. */
  setOnCommit(cb: CommitListener | null): void;
  /** Hydrate from disk. Replaces state; notifies subscribers, not onCommit. */
  load(docs: PageDoc[]): void;

  create(args: CreateArgs, id: PageId, now: number): PageDoc;
  rename(id: PageId, title: string, now: number): PageDoc | undefined;
  updateContent(
    id: PageId,
    content: unknown,
    text: string,
    now: number,
  ): PageDoc | undefined;
  setIcon(id: PageId, icon: string | null, now: number): PageDoc | undefined;
  setCover(id: PageId, cover: string | null, now: number): PageDoc | undefined;
  toggleFavorite(id: PageId, now: number): PageDoc | undefined;
  setTemplate(id: PageId, value: boolean, now: number): PageDoc | undefined;
  setPageOptions(
    args: {
      id: PageId;
      font?: "default" | "serif" | "mono";
      smallText?: boolean;
      fullWidth?: boolean;
      locked?: boolean;
    },
    now: number,
  ): PageDoc | undefined;
  move(id: PageId, parentId: PageId | undefined, rank: number, now: number): boolean;
  duplicate(
    id: PageId,
    newId: () => PageId,
    now: number,
    opts?: DuplicateOptions,
  ): { rootId: PageId; created: PageDoc[] } | null;
  trash(id: PageId, now: number): PageId[];
  restore(id: PageId, now: number): PageId[];
  deleteForever(id: PageId): PageId[];
  emptyTrash(): PageId[];
  updateDbProps(id: PageId, dbProps: DbProp[], now: number): PageDoc | undefined;
  setRowProp(
    id: PageId,
    propId: string,
    value: unknown,
    now: number,
  ): PageDoc | undefined;
  setView(
    args: {
      id: PageId;
      activeView?: ViewKind;
      boardGroupBy?: string;
      calendarBy?: string;
    },
    now: number,
  ): PageDoc | undefined;
  setViews(
    args: { id: PageId; views: DbView[] },
    now: number,
  ): PageDoc | undefined;
  bootstrap(id: PageId, now: number): PageDoc | null;

  applyServerDoc(doc: PageDoc): void;
  removePage(id: PageId): void;
  remapId(from: PageId, to: PageId): void;
}

export function createPageStore(): PageStore {
  const map = new Map<string, PageDoc>();
  let version = 0;
  const listeners = new Set<() => void>();
  let onCommit: CommitListener | null = null;

  function commit(changed: PageId[], removed: PageId[] = []) {
    version++;
    for (const l of [...listeners]) l();
    if (onCommit && (changed.length || removed.length)) {
      onCommit(changed, removed);
    }
  }

  function childrenOf(id: PageId): PageDoc[] {
    const out: PageDoc[] = [];
    for (const p of map.values()) if (p.parentId === id) out.push(p);
    return out;
  }

  function subtreeIds(rootId: PageId): PageId[] {
    if (!map.has(rootId)) return [];
    const out: PageId[] = [];
    const stack: PageId[] = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      for (const kid of childrenOf(id)) stack.push(kid._id);
    }
    return out;
  }

  function nextRank(parentId: PageId | undefined): number {
    let max = 0;
    for (const p of map.values()) {
      if (p.parentId === parentId && p.rank > max) max = p.rank;
    }
    return max + 1024;
  }

  return {
    get: (id) => map.get(id),
    all: () => [...map.values()],
    size: () => map.size,
    version: () => version,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setOnCommit(cb) {
      onCommit = cb;
    },
    load(docs) {
      map.clear();
      for (const doc of docs) map.set(doc._id, doc);
      version++;
      for (const l of [...listeners]) l();
    },

    create(args, id, now) {
      // Vault membership is inherited exactly like the server does it, so
      // the replica and Convex agree on which pages are encrypted.
      const parent = args.parentId ? map.get(args.parentId) : undefined;
      const vault = args.vault || parent?.vault ? true : undefined;
      const doc: PageDoc = {
        _id: id,
        _creationTime: now,
        title: args.title ?? "",
        type: args.type,
        parentId: args.parentId,
        rank: nextRank(args.parentId),
        icon: args.icon,
        props: args.props,
        vault,
        searchText: vault ? "" : (args.title ?? ""),
        updatedAt: now,
        ...(args.type === "database"
          ? {
              dbProps: structuredClone(DEFAULT_DB_PROPS),
              activeView: "table" as const,
              boardGroupBy: "status",
            }
          : {}),
      };
      map.set(id, doc);
      commit([id]);
      return doc;
    },

    rename(id, title, now) {
      const p = map.get(id);
      if (!p) return undefined;
      p.title = title;
      // Vault titles are ciphertext — keep them out of the search text.
      p.searchText = p.vault ? "" : title + " " + (p.contentText ?? "");
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    updateContent(id, content, text, now) {
      const p = map.get(id);
      if (!p) return undefined;
      p.content = content;
      p.contentText = p.vault ? "" : text;
      p.searchText = p.vault ? "" : p.title + " " + text;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setIcon(id, icon, now) {
      const p = map.get(id);
      if (!p) return undefined;
      if (icon === null) delete p.icon;
      else p.icon = icon;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setCover(id, cover, now) {
      const p = map.get(id);
      if (!p) return undefined;
      if (cover === null) delete p.cover;
      else p.cover = cover;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    toggleFavorite(id, now) {
      const p = map.get(id);
      if (!p) return undefined;
      p.isFavorite = !p.isFavorite;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setTemplate(id, value, now) {
      const p = map.get(id);
      if (!p) return undefined;
      p.isTemplate = value;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setPageOptions({ id, font, smallText, fullWidth, locked }, now) {
      const p = map.get(id);
      if (!p) return undefined;
      if (font !== undefined) p.font = font;
      if (smallText !== undefined) p.smallText = smallText;
      if (fullWidth !== undefined) p.fullWidth = fullWidth;
      if (locked !== undefined) p.locked = locked;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    move(id, parentId, rank, now) {
      // Prevent moving into own subtree.
      let cursor: PageId | undefined = parentId;
      while (cursor) {
        if (cursor === id) return false;
        cursor = map.get(cursor)?.parentId;
      }
      const p = map.get(id);
      if (!p) return false;
      p.parentId = parentId;
      p.rank = rank;
      p.updatedAt = now;
      commit([id]);
      return true;
    },

    duplicate(id, newId, now, opts) {
      const src = map.get(id);
      if (!src) return null;
      const created: PageDoc[] = [];
      const reparent = opts?.parentId !== undefined || opts?.toRoot === true;
      const clone = (
        page: PageDoc,
        parentId: PageId | undefined,
        rank: number,
        suffix: string,
        isRoot: boolean,
      ): PageId => {
        const copy: PageDoc = {
          ...structuredClone(page),
          _id: newId(),
          _creationTime: now,
          parentId,
          rank,
          // An encrypted title can't take a suffix without corrupting its
          // envelope; vault copies keep the title verbatim (server parity).
          title: page.vault ? page.title : page.title + suffix,
          isFavorite: false,
          updatedAt: now,
        };
        // The slug is the public-access control — never copy it (parity
        // with the server's clone).
        delete copy.publicSlug;
        delete copy.publishedAt;
        // Spawning *from* a template yields a normal page, not another one.
        if (isRoot && opts?.asInstance) delete copy.isTemplate;
        map.set(copy._id, copy);
        created.push(copy);
        for (const kid of childrenOf(page._id).sort((a, b) => a.rank - b.rank)) {
          clone(kid, copy._id, kid.rank, "", false);
        }
        return copy._id;
      };
      const rootId = clone(
        src,
        reparent ? opts?.parentId : src.parentId,
        reparent ? nextRank(opts?.parentId) : src.rank + 1,
        opts?.suffix ?? " (copy)",
        true,
      );
      commit(created.map((c) => c._id));
      return { rootId, created };
    },

    trash(id, now) {
      const ids = subtreeIds(id);
      for (const sid of ids) {
        const p = map.get(sid)!;
        p.inTrash = true;
        p.trashRoot = sid === id;
        p.trashedAt = now;
        p.isFavorite = false;
        p.updatedAt = now;
      }
      if (ids.length) commit(ids);
      return ids;
    },

    restore(id, now) {
      const p = map.get(id);
      if (!p) return [];
      let parentId = p.parentId;
      if (parentId) {
        const parent = map.get(parentId);
        if (!parent || parent.inTrash) parentId = undefined;
      }
      const ids = subtreeIds(id);
      for (const sid of ids) {
        const s = map.get(sid)!;
        delete s.inTrash;
        delete s.trashRoot;
        delete s.trashedAt;
        s.updatedAt = now;
      }
      p.parentId = parentId;
      if (ids.length) commit(ids);
      return ids;
    },

    deleteForever(id) {
      const ids = subtreeIds(id);
      for (const sid of ids) map.delete(sid);
      if (ids.length) commit([], ids);
      return ids;
    },

    emptyTrash() {
      const removed: PageId[] = [];
      for (const p of [...map.values()]) {
        if (p.inTrash) {
          map.delete(p._id);
          removed.push(p._id);
        }
      }
      if (removed.length) commit([], removed);
      return removed;
    },

    updateDbProps(id, dbProps, now) {
      const p = map.get(id);
      if (!p) return undefined;
      p.dbProps = dbProps;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setRowProp(id, propId, value, now) {
      const p = map.get(id);
      if (!p) return undefined;
      const props = { ...(p.props ?? {}) };
      if (value === null) delete props[propId];
      else props[propId] = value;
      p.props = props;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setView({ id, activeView, boardGroupBy, calendarBy }, now) {
      const p = map.get(id);
      if (!p) return undefined;
      if (activeView !== undefined) p.activeView = activeView;
      if (boardGroupBy !== undefined) p.boardGroupBy = boardGroupBy;
      if (calendarBy !== undefined) p.calendarBy = calendarBy;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    setViews({ id, views }, now) {
      const p = map.get(id);
      if (!p) return undefined;
      p.views = views;
      p.updatedAt = now;
      commit([id]);
      return p;
    },

    bootstrap(id, now) {
      if (map.size) return null;
      const doc: PageDoc = {
        _id: id,
        _creationTime: now,
        title: "Welcome to Vellum",
        type: "doc",
        rank: 1024,
        icon: "👋",
        cover: "gradient:4",
        updatedAt: now,
        searchText: "Welcome to Vellum",
        content: structuredClone(WELCOME_CONTENT),
      };
      map.set(id, doc);
      commit([id]);
      return doc;
    },

    applyServerDoc(doc) {
      map.set(doc._id, doc);
      commit([doc._id]);
    },

    removePage(id) {
      if (!map.delete(id)) return;
      commit([], [id]);
    },

    remapId(from, to) {
      const doc = map.get(from);
      if (!doc) return;
      map.delete(from);
      doc._id = to;
      map.set(to, doc);
      const changed: PageId[] = [to];
      for (const p of map.values()) {
        let touched = false;
        if (p.parentId === from) {
          p.parentId = to;
          touched = true;
        }
        // Known gap, deliberate for now: a Vault page's content is an
        // encrypted envelope, so a temp id sealed inside it is invisible to
        // this rewrite. Creating a sub-page inside the Vault while offline
        // therefore leaves that block pointing at a dead id once the create
        // syncs. Fixing it means remapping at *decrypt* time (the gate in
        // PageView holds the plaintext) against a persisted temp→real map,
        // since the id may land while the vault is locked — more machinery
        // than the rest of this function, and the same class of hazard as
        // the pageLink/relation/targetId cases below.
        if (p.content && rewriteContentIds(p.content, from, to)) touched = true;
        // Relation property values hold page ids; so does a relation
        // column's targetId. Without these, an offline-created row stays
        // linked to a dead temp id after its create syncs.
        if (p.props) {
          const next = rewriteValueIds(p.props, from, to) as PageDoc["props"];
          if (JSON.stringify(next) !== JSON.stringify(p.props)) {
            p.props = next;
            touched = true;
          }
        }
        if (p.dbProps) {
          for (const dp of p.dbProps) {
            if (dp.targetId === from) {
              dp.targetId = to;
              touched = true;
            }
          }
        }
        if (touched && p._id !== to) changed.push(p._id);
      }
      commit(changed, [from]);
    },
  };
}
