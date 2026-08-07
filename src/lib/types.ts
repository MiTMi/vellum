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
  /** End-to-end encrypted Vault member (root included). Encrypted title. */
  vault: boolean;
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
  | "relation"
  | "createdTime"
  | "lastEditedTime"
  | "rollup"
  | "formula"
  | "ai";

/** Aggregations a rollup property can apply to the related rows. */
export type RollupCalc =
  | "count"
  | "countValues"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "percentChecked"
  | "showOriginal";

/** Property types whose value is computed at render, never stored. */
export const COMPUTED_PROP_TYPES: PropType[] = [
  "createdTime",
  "lastEditedTime",
  "rollup",
  "formula",
];

export type ViewKind =
  | "table"
  | "board"
  | "calendar"
  | "gallery"
  | "timeline";

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
  /** rollup props: which relation column of this database to follow */
  relationPropId?: string;
  /** rollup props: which property of the target rows ("__title" allowed) */
  rollupPropId?: string;
  /** rollup props: how to aggregate the collected values */
  rollupCalc?: RollupCalc | string;
  /** formula props: expression source, evaluated at render */
  formula?: string;
  /** ai props: what to generate for each row */
  aiKind?: AiPropKind;
  /** ai props: the instruction, when `aiKind` is "custom" */
  aiPrompt?: string;
}

export interface PagesIndex {
  loading: boolean;
  all: PageMeta[];
  byId: Map<string, PageMeta>;
  children: Map<string, PageMeta[]>; // key: parentId or "root"
  favorites: PageMeta[];
  templates: PageMeta[];
  /** The vault root, if one exists. Its subtree is E2E encrypted. */
  vaultRoot: PageMeta | null;
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
  /** End-to-end encrypted Vault member — title/content are ciphertext. */
  vault?: boolean;
  inTrash?: boolean;
  trashRoot?: boolean;
  trashedAt?: number;
  dbProps?: DbProp[];
  activeView?: ViewKind;
  boardGroupBy?: string;
  calendarBy?: string;
  updatedAt: number;
  /** Set while the page is published to the web (see pages.setPublished). */
  publicSlug?: string;
  publishedAt?: number;
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

export interface CommentMeta {
  _id: string;
  pageId: PageId;
  text: string;
  createdAt: number;
  resolved?: boolean;
}

/** Open Graph metadata for a bookmark block. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
}

/** Writing-assistant operations (convex/ai.ts `transform`). */
export type AiTransformKind =
  | "improve"
  | "fix"
  | "shorter"
  | "longer"
  | "summarize"
  | "bullets"
  | "tone"
  | "translate"
  | "continue"
  | "custom";

/** What an AI database column generates for each row. */
export type AiPropKind =
  | "summary"
  | "keyTopics"
  | "sentiment"
  | "actionItems"
  | "custom";

/** A page the Q&A answer drew on, rendered as a clickable citation. */
export interface AiSource {
  pageId: PageId;
  title: string;
  icon: string | null;
}

export interface AiAnswer {
  answer: string;
  sources: AiSource[];
  /** Echoed back so the UI can show which model produced the answer. */
  model: string;
}

export interface TrashedMeta {
  _id: PageId;
  title: string;
  icon: string | null;
  type: "doc" | "database";
  vault?: boolean;
  trashedAt: number;
}

export interface SearchHit {
  _id: PageId;
  title: string;
  icon: string | null;
  type: "doc" | "database";
  parentId: PageId | null;
  /** Body-text context around the match; null when only the title matched. */
  snippet: string | null;
}

/** A page that links to the current page ("Linked mentions"). */
export interface BacklinkMeta {
  _id: PageId;
  title: string;
  icon: string | null;
  type: "doc" | "database";
}
