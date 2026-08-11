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
    let vaultRoot: PageMeta | null = null;
    for (const p of all) {
      if (p.vault && !(p.parentId && byId.get(p.parentId)?.vault)) {
        vaultRoot = p;
      }
    }
    for (const p of all) {
      // Template roots live in their own sidebar section, not the tree —
      // but their children still land in `children` so the template's own
      // subtree renders normally once you open it.
      if (p.isTemplate) continue;
      // Vault pages never enter the tree: the root has its own sidebar
      // entry, and its children are listed only inside the unlocked
      // VaultView — the sidebar must not reveal the vault's structure.
      if (p.vault) continue;
      // Shared roots live in the "Shared" section, not the main tree — a
      // top-level shared page (parentId null) must not show up twice.
      if (p.role && (!p.parentId || !byId.has(p.parentId))) continue;
      const key = childrenKey(p.parentId);
      const list = children.get(key);
      if (list) list.push(p);
      else children.set(key, [p]);
    }
    for (const list of children.values()) list.sort((a, b) => a.rank - b.rank);
    // isFavorite/isTemplate on a shared page are the OWNER's flags — they
    // must not populate my sections (and the toggles are owner-only).
    const favorites = all
      .filter((p) => p.isFavorite && !p.vault && !p.role)
      .sort((a, b) => a.title.localeCompare(b.title));
    const templates = all
      .filter((p) => p.isTemplate && !p.vault && !p.role)
      .sort((a, b) => a.title.localeCompare(b.title));
    // Shared subtree roots: shared with me, and the parent isn't in my
    // replica (the shared root's parent belongs to the owner's private
    // tree). They root the sidebar's "Shared" section; their descendants
    // are in `children` and expand normally.
    const sharedRoots = all
      .filter((p) => p.role && (!p.parentId || !byId.has(p.parentId)))
      .sort((a, b) => a.title.localeCompare(b.title));
    return {
      loading: pages === undefined,
      all,
      byId,
      children,
      favorites,
      templates,
      vaultRoot,
      sharedRoots,
    };
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
