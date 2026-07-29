import {
  BacklinkMeta,
  DbProp,
  LinkPreview,
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
  VersionDoc,
  VersionMeta,
  ViewKind,
} from "../lib/types";

/**
 * The data layer contract. Three implementations exist:
 *  - offline.ts — local replica + outbox synced to Convex (the default;
 *    requires VITE_CONVEX_URL; works fully offline)
 *  - real.ts — direct Convex queries/mutations, no offline support
 *    (escape hatch; VITE_DIRECT_CONVEX=1)
 *  - mock.ts — in-memory + localStorage (demo mode / tests; VITE_MOCK_CONVEX=1)
 */
export interface DataApi {
  usePagesList(): PageMeta[] | undefined;
  usePage(id: PageId | null): PageDoc | null | undefined;
  useTrashed(): TrashedMeta[] | undefined;
  useSearch(term: string): SearchHit[] | undefined;
  useBacklinks(id: PageId | null): BacklinkMeta[] | undefined;
  useMutations(): Mutations;
  useFileUpload(): (file: File) => Promise<string>;
  /**
   * Page history. Plain callbacks rather than reactive hooks: offline mode
   * has no ConvexProvider, so these read straight through the Convex client
   * and are only available while connected (`available`).
   */
  useVersionHistory(): VersionHistoryApi;
  /** Fetch Open Graph metadata for a URL (bookmark block). Null if offline. */
  useLinkPreview(): (url: string) => Promise<LinkPreview | null>;
}

export interface VersionHistoryApi {
  available: boolean;
  list(pageId: PageId): Promise<VersionMeta[]>;
  get(id: string): Promise<VersionDoc | null>;
}

export interface Mutations {
  create(args: {
    parentId?: PageId;
    type: "doc" | "database";
    title?: string;
    icon?: string;
    props?: Record<string, unknown>;
  }): Promise<PageId>;
  rename(args: { id: PageId; title: string }): Promise<void>;
  updateContent(args: { id: PageId; content: unknown; text: string }): Promise<void>;
  setIcon(args: { id: PageId; icon: string | null }): Promise<void>;
  setCover(args: { id: PageId; cover: string | null }): Promise<void>;
  toggleFavorite(args: { id: PageId }): Promise<void>;
  setTemplate(args: { id: PageId; value: boolean }): Promise<void>;
  setPageOptions(args: {
    id: PageId;
    font?: "default" | "serif" | "mono";
    smallText?: boolean;
    fullWidth?: boolean;
    locked?: boolean;
  }): Promise<void>;
  move(args: { id: PageId; parentId?: PageId; rank: number }): Promise<void>;
  duplicate(args: {
    id: PageId;
    /** Destination parent; requires `toRoot` to target the top level. */
    parentId?: PageId;
    /** Title suffix for the root copy. Defaults to " (copy)". */
    suffix?: string;
    /** Spawning from a template — the copy is a normal page. */
    asInstance?: boolean;
    /** Reparent the copy (to `parentId`, or the top level when omitted). */
    toRoot?: boolean;
  }): Promise<PageId | null>;
  trash(args: { id: PageId }): Promise<void>;
  restore(args: { id: PageId }): Promise<void>;
  deleteForever(args: { id: PageId }): Promise<void>;
  emptyTrash(): Promise<void>;
  updateDbProps(args: { id: PageId; dbProps: DbProp[] }): Promise<void>;
  setRowProp(args: { id: PageId; propId: string; value: unknown }): Promise<void>;
  setView(args: {
    id: PageId;
    activeView?: ViewKind;
    boardGroupBy?: string;
    calendarBy?: string;
  }): Promise<void>;
  bootstrap(): Promise<PageId | null>;
}

export const IS_MOCK = import.meta.env.VITE_MOCK_CONVEX === "1";
export const IS_DIRECT = import.meta.env.VITE_DIRECT_CONVEX === "1";
