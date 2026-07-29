import { Id } from "../../convex/_generated/dataModel";

export type PageId = Id<"pages">;

/** Lightweight page record returned by api.pages.list */
export interface PageMeta {
  _id: PageId;
  title: string;
  type: "doc" | "database";
  parentId: PageId | null;
  rank: number;
  icon: string | null;
  isFavorite: boolean;
  props: Record<string, unknown> | null;
  updatedAt: number;
  _creationTime: number;
}

export type PropType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "date"
  | "checkbox"
  | "url";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface DbProp {
  id: string;
  name: string;
  type: PropType;
  width?: number;
  options?: SelectOption[];
}

export interface PagesIndex {
  loading: boolean;
  all: PageMeta[];
  byId: Map<string, PageMeta>;
  children: Map<string, PageMeta[]>; // key: parentId or "root"
  favorites: PageMeta[];
}

export function childrenKey(parentId: PageId | null): string {
  return parentId ?? "root";
}

/** Full page document (mirror of the Convex schema). */
export interface PageDoc {
  _id: PageId;
  _creationTime: number;
  title: string;
  type: "doc" | "database";
  parentId?: PageId;
  rank: number;
  icon?: string;
  cover?: string;
  content?: unknown;
  contentText?: string;
  searchText?: string;
  props?: Record<string, unknown>;
  isFavorite?: boolean;
  font?: "default" | "serif" | "mono";
  smallText?: boolean;
  fullWidth?: boolean;
  locked?: boolean;
  inTrash?: boolean;
  trashRoot?: boolean;
  trashedAt?: number;
  dbProps?: DbProp[];
  activeView?: "table" | "board" | "calendar";
  boardGroupBy?: string;
  calendarBy?: string;
  updatedAt: number;
}

export interface TrashedMeta {
  _id: PageId;
  title: string;
  icon: string | null;
  type: "doc" | "database";
  trashedAt: number;
}

export interface SearchHit {
  _id: PageId;
  title: string;
  icon: string | null;
  type: "doc" | "database";
  parentId: PageId | null;
}
