import { useMemo } from "react";
import { usePagesList } from "../data";
import { PageMeta, PagesIndex, childrenKey } from "../lib/types";

export function usePagesIndex(): PagesIndex {
  const pages = usePagesList();

  return useMemo(() => {
    const all = pages ?? [];
    const byId = new Map<string, PageMeta>();
    const children = new Map<string, PageMeta[]>();
    for (const p of all) byId.set(p._id, p);
    for (const p of all) {
      const key = childrenKey(p.parentId);
      const list = children.get(key);
      if (list) list.push(p);
      else children.set(key, [p]);
    }
    for (const list of children.values()) list.sort((a, b) => a.rank - b.rank);
    const favorites = all
      .filter((p) => p.isFavorite)
      .sort((a, b) => a.title.localeCompare(b.title));
    return { loading: pages === undefined, all, byId, children, favorites };
  }, [pages]);
}

/** Walk up the parent chain to build a breadcrumb path (root → page). */
export function pathTo(index: PagesIndex, id: string | null): PageMeta[] {
  const path: PageMeta[] = [];
  let cursor = id ? index.byId.get(id) : undefined;
  let guard = 0;
  while (cursor && guard++ < 50) {
    path.unshift(cursor);
    cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
  }
  return path;
}
