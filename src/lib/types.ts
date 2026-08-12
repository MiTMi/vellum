import { Id } from "../../convex/_generated/dataModel";

export type PageId = Id<"pages">;

/**
 * My access to a page shared with me (Phase 2). Absent on pages I own.
 * Viewer-relative — stamped by the server on syncIndex/getMany/get, stored
 * on the replica doc, never written back.
 */
export type ShareRole = "viewer" | "editor";

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
  /** Set when this page is shared with me rather than mine. */
  role?: ShareRole;
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

/* ---- Saved database views (synced; see lib/dbviews.ts) ---- */

export type FilterOp =
  // text / url / ai (and formula/rollup values compared loosely)
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  // number
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  // date (also createdTime / lastEditedTime)
  | "dateIs"
  | "dateBefore"
  | "dateAfter"
  | "dateOnOrBefore"
  | "dateOnOrAfter"
  // select / multiSelect (value: option ids)
  | "anyOf"
  | "noneOf"
  // checkbox
  | "checked"
  | "unchecked"
  // any type
  | "isEmpty"
  | "isNotEmpty";

export interface FilterCondition {
  /** Property id, or "__title" for the title column. */
  propId: string;
  op: FilterOp;
  /**
   * Comparison operand; shape depends on `op`. Never a page id — relation
   * props only support isEmpty/isNotEmpty, which is what keeps unsynced
   * temp ids out of `views` (store.remapId doesn't walk it).
   */
  value?: string | number | string[];
}

export interface FilterGroup {
  logic: "and" | "or";
  /** Conditions plus at most one level of nested groups (validator + UI cap). */
  conditions: (FilterCondition | FilterGroup)[];
}

export interface SortRule {
  key: string; // property id or "__title"
  dir: "asc" | "desc";
}

/** One saved view of a database. The whole array syncs via `setViews`. */
export interface DbView {
  id: string;
  name: string;
  kind: ViewKind;
  filter?: FilterGroup;
  sorts?: SortRule[];
  /** Table-view grouping property. */
  groupBy?: string;
  boardGroupBy?: string;
  calendarBy?: string;
}

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
  /**
   * Roots of subtrees shared with me — pages carrying a `role` whose
   * parent isn't in my replica. The sidebar's "Shared" section.
   */
  sharedRoots: PageMeta[];
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
  /**
   * Saved views. Once present, the legacy trio below is a read-only
   * fallback for deriving the initial set — never dual-write them.
   */
  views?: DbView[];
  activeView?: ViewKind;
  boardGroupBy?: string;
  calendarBy?: string;
  updatedAt: number;
  /** Set while the page is published to the web (see pages.setPublished). */
  publicSlug?: string;
  publishedAt?: number;
  /**
   * My role on a page shared with me (absent on my own pages). Server-
   * stamped; stripped by toCreatePayload so it can never ride a create.
   */
  role?: ShareRole;
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

/** One exchange in the AI side panel. */
export interface AiChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** The agent's reply: an answer plus an optional additive plan the user
 *  can apply with one click (docs/ai-agent-design.md). */
export interface AgentAnswer extends AiAnswer {
  plan: import("../../convex/lib/agentPlan").AgentOp[] | null;
}

/** A rendered panel message — a turn plus what the answer drew on. */
export interface AiChatMessage extends AiChatTurn {
  sources?: AiSource[];
  /** A proposed plan awaiting Apply/Dismiss (workspace agent). */
  plan?: import("../../convex/lib/agentPlan").AgentOp[] | null;
  /** Set once the plan was applied — collapses the card into a receipt. */
  planApplied?: boolean;
  /** Set instead of `content` when the request failed, so the thread keeps
   *  its shape and the user can retry without losing the conversation. */
  error?: string;
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
