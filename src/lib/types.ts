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
  cover: string | null;
  isFavorite: boolean;
  isTemplate: boolean;
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
  | "url"
  | "relation";

export type ViewKind = "table" | "board" | "calendar" | "gallery";

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
  /** relation props: the database page whose rows this links to */
  targetId?: string;
}

export interface PagesIndex {
  loading: boolean;
  all: PageMeta[];
  byId: Map<string, PageMeta>;
  children: Map<string, PageMeta[]>; // key: parentId or "root"
  favorites: PageMeta[];
  templates: PageMeta[];
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
  isTemplate?: boolean;
  font?: "default" | "serif" | "mono";
  smallText?: boolean;
  fullWidth?: boolean;
  locked?: boolean;
  inTrash?: boolean;
  trashRoot?: boolean;
  trashedAt?: number;
  dbProps?: DbProp[];
  activeView?: ViewKind;
  boardGroupBy?: string;
  calendarBy?: string;
  updatedAt: number;
}

/** One entry in a page's history (metadata only — content fetched on demand). */
export interface VersionMeta {
  _id: string;
  title: string;
  savedAt: number;
}

export interface VersionDoc extends VersionMeta {
  pageId: PageId;
  content?: unknown;
}

/** Open Graph metadata for a bookmark block. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
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

/** A page that links to the current page ("Linked mentions"). */
export interface BacklinkMeta {
  _id: PageId;
  title: string;
  icon: string | null;
  type: "doc" | "database";
}
