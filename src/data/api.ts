import {
  DbProp,
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
} from "../lib/types";

/**
 * The data layer contract. Two implementations exist:
 *  - real.ts — Convex (the default; requires VITE_CONVEX_URL)
 *  - mock.ts — in-memory + localStorage (demo mode / tests; VITE_MOCK_CONVEX=1)
 */
export interface DataApi {
  usePagesList(): PageMeta[] | undefined;
  usePage(id: PageId | null): PageDoc | null | undefined;
  useTrashed(): TrashedMeta[] | undefined;
  useSearch(term: string): SearchHit[] | undefined;
  useMutations(): Mutations;
  useFileUpload(): (file: File) => Promise<string>;
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
  setPageOptions(args: {
    id: PageId;
    font?: "default" | "serif" | "mono";
    smallText?: boolean;
    fullWidth?: boolean;
    locked?: boolean;
  }): Promise<void>;
  move(args: { id: PageId; parentId?: PageId; rank: number }): Promise<void>;
  duplicate(args: { id: PageId }): Promise<PageId | null>;
  trash(args: { id: PageId }): Promise<void>;
  restore(args: { id: PageId }): Promise<void>;
  deleteForever(args: { id: PageId }): Promise<void>;
  emptyTrash(): Promise<void>;
  updateDbProps(args: { id: PageId; dbProps: DbProp[] }): Promise<void>;
  setRowProp(args: { id: PageId; propId: string; value: unknown }): Promise<void>;
  setView(args: {
    id: PageId;
    activeView?: "table" | "board" | "calendar";
    boardGroupBy?: string;
    calendarBy?: string;
  }): Promise<void>;
  bootstrap(): Promise<PageId | null>;
}

export const IS_MOCK = import.meta.env.VITE_MOCK_CONVEX === "1";
