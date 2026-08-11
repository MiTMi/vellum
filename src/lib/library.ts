import { PageId, PageMeta, PagesIndex } from "./types";

/**
 * The Library — a workspace-wide index page (Notion's "Library"): recents,
 * favorites, every private page, templates, in one sortable table.
 *
 * It routes through the ordinary nav machinery with a sentinel page id, so
 * tabs, history and ⌘-navigation all work unchanged. Anything that treats
 * `pageId` as a real page must check `isLibraryId` first (App.tsx guards
 * the disappeared-page fallback and ⌘D; TabBar/TopBar special-case the
 * title). The sentinel can never collide with a Convex id or a `local_`
 * temp id.
 */
export const LIBRARY_ID = "__library" as PageId;

export function isLibraryId(id: string | null): boolean {
  return id === LIBRARY_ID;
}

export type LibraryTab =
  | "recents"
  | "favorites"
  | "private"
  | "shared"
  | "templates";

export const LIBRARY_TABS: { key: LibraryTab; label: string }[] = [
  { key: "recents", label: "Recents" },
  { key: "favorites", label: "Favorites" },
  { key: "private", label: "Private" },
  { key: "shared", label: "Shared" },
  { key: "templates", label: "Templates" },
];

export interface LibraryRow {
  page: PageMeta;
  /** Where the page lives: a parent page/database, or top-level "Private". */
  source: PageMeta | null;
  /** Last visited on this device; null if never visited here. */
  visitedAt: number | null;
}

const RECENTS_CAP = 30;

/**
 * Rows for one Library tab. Pure so it's unit-testable. Vault pages
 * (root included) never appear — their titles are ciphertext and the
 * Library must not reveal the vault's contents (same rule as sidebar
 * recents and ⌘K).
 */
export function libraryRows(
  index: PagesIndex,
  tab: LibraryTab,
  visits: Record<string, number>,
  term: string,
): LibraryRow[] {
  let pages: PageMeta[];
  switch (tab) {
    case "recents":
      // Never-visited pages fall back to their edit time, so a fresh
      // device still sees a sensible list rather than an empty tab.
      pages = index.all
        .filter((p) => !p.vault && !p.isTemplate)
        .sort(
          (a, b) =>
            (visits[b._id] ?? b.updatedAt) - (visits[a._id] ?? a.updatedAt),
        )
        .slice(0, RECENTS_CAP);
      break;
    case "favorites":
      pages = index.favorites;
      break;
    case "private":
      pages = index.all
        .filter((p) => !p.vault && !p.isTemplate && !p.role)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      break;
    case "shared":
      // Every page shared with me (roots and descendants alike), newest
      // edit first — the whole point is seeing what others changed.
      pages = index.all
        .filter((p) => p.role !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      break;
    case "templates":
      pages = index.templates;
      break;
  }

  const t = term.trim().toLowerCase();
  if (t) pages = pages.filter((p) => (p.title || "Untitled").toLowerCase().includes(t));

  return pages.map((page) => ({
    page,
    source: page.parentId ? (index.byId.get(page.parentId) ?? null) : null,
    visitedAt: visits[page._id] ?? null,
  }));
}
