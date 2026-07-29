import { useCallback, useMemo, useSyncExternalStore } from "react";
import { DataApi, Mutations } from "./api";
import {
  DbProp,
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
} from "../lib/types";

/**
 * In-memory implementation of the data layer (demo mode & tests).
 * Mirrors the behavior of convex/pages.ts against a local array,
 * persisted to localStorage.
 */

let seq = 0;
function newId(): PageId {
  return `mock_${Date.now().toString(36)}_${(seq++).toString(36)}` as PageId;
}

let pages: PageDoc[] = load();
let version = 0;
const listeners = new Set<() => void>();

function load(): PageDoc[] {
  try {
    const raw = localStorage.getItem("vellum:mockdb");
    if (raw) return JSON.parse(raw) as PageDoc[];
  } catch {
    /* ignore */
  }
  return [];
}

function persist() {
  try {
    localStorage.setItem("vellum:mockdb", JSON.stringify(pages));
  } catch {
    /* ignore */
  }
}

function commit() {
  version++;
  persist();
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function byId(id: PageId): PageDoc | undefined {
  return pages.find((p) => p._id === id);
}

function childrenOf(id: PageId): PageDoc[] {
  return pages.filter((p) => p.parentId === id);
}

function subtreeIds(rootId: PageId): PageId[] {
  const out: PageId[] = [];
  const stack: PageId[] = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (!byId(id)) continue;
    out.push(id);
    for (const kid of childrenOf(id)) stack.push(kid._id);
  }
  return out;
}

function nextRank(parentId: PageId | undefined): number {
  let max = 0;
  for (const p of pages) {
    if (p.parentId === parentId && p.rank > max) max = p.rank;
  }
  return max + 1024;
}

const mutations: Mutations = {
  async create(args) {
    const now = Date.now();
    const doc: PageDoc = {
      _id: newId(),
      _creationTime: now,
      title: args.title ?? "",
      type: args.type,
      parentId: args.parentId,
      rank: nextRank(args.parentId),
      icon: args.icon,
      props: args.props,
      searchText: args.title ?? "",
      updatedAt: now,
      ...(args.type === "database"
        ? {
            dbProps: [
              { id: "status", name: "Status", type: "select" as const, options: [
                { id: "todo", name: "Not started", color: "gray" },
                { id: "doing", name: "In progress", color: "blue" },
                { id: "done", name: "Done", color: "green" },
              ] },
              { id: "tags", name: "Tags", type: "multiSelect" as const, options: [] },
              { id: "date", name: "Date", type: "date" as const },
            ],
            activeView: "table" as const,
            boardGroupBy: "status",
          }
        : {}),
    };
    pages.push(doc);
    commit();
    return doc._id;
  },

  async rename({ id, title }) {
    const p = byId(id);
    if (!p) return;
    p.title = title;
    p.searchText = title + " " + (p.contentText ?? "");
    p.updatedAt = Date.now();
    commit();
  },

  async updateContent({ id, content, text }) {
    const p = byId(id);
    if (!p) return;
    p.content = content;
    p.contentText = text;
    p.searchText = p.title + " " + text;
    p.updatedAt = Date.now();
    commit();
  },

  async setIcon({ id, icon }) {
    const p = byId(id);
    if (!p) return;
    p.icon = icon === null ? undefined : icon;
    p.updatedAt = Date.now();
    commit();
  },

  async setCover({ id, cover }) {
    const p = byId(id);
    if (!p) return;
    p.cover = cover === null ? undefined : cover;
    p.updatedAt = Date.now();
    commit();
  },

  async toggleFavorite({ id }) {
    const p = byId(id);
    if (!p) return;
    p.isFavorite = !p.isFavorite;
    commit();
  },

  async setPageOptions({ id, font, smallText, fullWidth, locked }) {
    const p = byId(id);
    if (!p) return;
    if (font !== undefined) p.font = font;
    if (smallText !== undefined) p.smallText = smallText;
    if (fullWidth !== undefined) p.fullWidth = fullWidth;
    if (locked !== undefined) p.locked = locked;
    commit();
  },

  async move({ id, parentId, rank }) {
    // Prevent moving into own subtree.
    let cursor: PageId | undefined = parentId;
    while (cursor) {
      if (cursor === id) return;
      cursor = byId(cursor)?.parentId;
    }
    const p = byId(id);
    if (!p) return;
    p.parentId = parentId;
    p.rank = rank;
    commit();
  },

  async duplicate({ id }) {
    const src = byId(id);
    if (!src) return null;
    const clone = (page: PageDoc, parentId: PageId | undefined, rank: number, suffix: string): PageId => {
      const copy: PageDoc = {
        ...structuredClone(page),
        _id: newId(),
        _creationTime: Date.now(),
        parentId,
        rank,
        title: page.title + suffix,
        isFavorite: false,
        updatedAt: Date.now(),
      };
      pages.push(copy);
      for (const kid of childrenOf(page._id).sort((a, b) => a.rank - b.rank)) {
        clone(kid, copy._id, kid.rank, "");
      }
      return copy._id;
    };
    const newRoot = clone(src, src.parentId, src.rank + 1, " (copy)");
    commit();
    return newRoot;
  },

  async trash({ id }) {
    const now = Date.now();
    for (const sid of subtreeIds(id)) {
      const p = byId(sid)!;
      p.inTrash = true;
      p.trashRoot = sid === id;
      p.trashedAt = now;
      p.isFavorite = false;
    }
    commit();
  },

  async restore({ id }) {
    const p = byId(id);
    if (!p) return;
    let parentId = p.parentId;
    if (parentId) {
      const parent = byId(parentId);
      if (!parent || parent.inTrash) parentId = undefined;
    }
    for (const sid of subtreeIds(id)) {
      const s = byId(sid)!;
      delete s.inTrash;
      delete s.trashRoot;
      delete s.trashedAt;
    }
    p.parentId = parentId;
    commit();
  },

  async deleteForever({ id }) {
    const ids = new Set(subtreeIds(id));
    pages = pages.filter((p) => !ids.has(p._id));
    commit();
  },

  async emptyTrash() {
    pages = pages.filter((p) => !p.inTrash);
    commit();
  },

  async updateDbProps({ id, dbProps }) {
    const p = byId(id);
    if (!p) return;
    p.dbProps = dbProps as DbProp[];
    p.updatedAt = Date.now();
    commit();
  },

  async setRowProp({ id, propId, value }) {
    const p = byId(id);
    if (!p) return;
    const props = { ...(p.props ?? {}) };
    if (value === null) delete props[propId];
    else props[propId] = value;
    p.props = props;
    p.updatedAt = Date.now();
    commit();
  },

  async setView({ id, activeView, boardGroupBy, calendarBy }) {
    const p = byId(id);
    if (!p) return;
    if (activeView !== undefined) p.activeView = activeView;
    if (boardGroupBy !== undefined) p.boardGroupBy = boardGroupBy;
    if (calendarBy !== undefined) p.calendarBy = calendarBy;
    commit();
  },

  async bootstrap() {
    if (pages.length) return null;
    const now = Date.now();
    const doc: PageDoc = {
      _id: newId(),
      _creationTime: now,
      title: "Welcome to Vellum",
      type: "doc",
      rank: 1024,
      icon: "👋",
      cover: "gradient:4",
      updatedAt: now,
      searchText: "Welcome to Vellum",
      content: [
        { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Your workspace, your rules", styles: {} }] },
        { type: "paragraph", content: [{ type: "text", text: "Vellum is your personal Notion-style workspace. Everything you write is saved instantly.", styles: {} }] },
        { type: "paragraph", content: [] },
        { type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Things to try", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Type / anywhere to insert headings, tables, images, and more", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Press ⌘K to search and jump between pages", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Hover the page title to add an icon or a cover", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Create a database from the sidebar — tables and boards included", styles: {} }] },
      ],
    };
    pages.push(doc);
    commit();
    return doc._id;
  },
};

function useVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

const mockApi: DataApi = {
  usePagesList() {
    const v = useVersion();
    return useMemo<PageMeta[]>(
      () =>
        pages
          .filter((p) => !p.inTrash)
          .map((p) => ({
            _id: p._id,
            title: p.title,
            type: p.type,
            parentId: p.parentId ?? null,
            rank: p.rank,
            icon: p.icon ?? null,
            isFavorite: p.isFavorite ?? false,
            props: p.props ?? null,
            updatedAt: p.updatedAt,
            _creationTime: p._creationTime,
          })),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [v],
    );
  },

  usePage(id: PageId | null) {
    const v = useVersion();
    return useMemo<PageDoc | null | undefined>(
      () => (id ? (byId(id) ? structuredClone(byId(id)!) : null) : undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [id, v],
    );
  },

  useTrashed() {
    const v = useVersion();
    return useMemo<TrashedMeta[]>(
      () =>
        pages
          .filter((p) => p.inTrash && p.trashRoot)
          .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
          .map((p) => ({
            _id: p._id,
            title: p.title,
            icon: p.icon ?? null,
            type: p.type,
            trashedAt: p.trashedAt ?? 0,
          })),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [v],
    );
  },

  useSearch(term: string) {
    const v = useVersion();
    return useMemo<SearchHit[]>(() => {
      const t = term.trim().toLowerCase();
      if (!t) return [];
      return pages
        .filter((p) => !p.inTrash && (p.searchText ?? "").toLowerCase().includes(t))
        .slice(0, 20)
        .map((p) => ({
          _id: p._id,
          title: p.title,
          icon: p.icon ?? null,
          type: p.type,
          parentId: p.parentId ?? null,
        }));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [term, v]);
  },

  useMutations() {
    return mutations;
  },

  useFileUpload() {
    return useCallback(async (file: File): Promise<string> => {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
    }, []);
  },
};

export default mockApi;
