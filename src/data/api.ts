import {
  AiAnswer,
  AiChatTurn,
  AiPropKind,
  AiTransformKind,
  BacklinkMeta,
  CommentMeta,
  DbProp,
  DbView,
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
  /** Page comments — same server-only shape as version history. */
  useComments(): CommentsApi;
  /** Publish to web — server-only, like history and comments. */
  usePublish(): PublishApi;
  /** Account management (Settings) — server-only, single-owner. */
  useAccount(): AccountApi;
  /** Notion-style AI. Server-only: the model key lives in Convex env. */
  useAi(): AiApi;
}

export interface AiApi {
  /**
   * False while offline and in mock mode — every call is a live model
   * round-trip, so the AI affordances hide themselves rather than failing.
   */
  available: boolean;
  /** Rewrite/summarize/translate a text selection. Returns the new text. */
  transform(args: {
    text: string;
    kind: AiTransformKind;
    /** Target tone, target language, or a free-form instruction. */
    option?: string;
  }): Promise<string>;
  /** Generate one AI-column value for one database row. */
  fillProperty(args: {
    pageId: PageId;
    kind: AiPropKind;
    prompt?: string;
  }): Promise<string>;
  /** Answer a question from the workspace, with page citations. */
  ask(question: string): Promise<AiAnswer>;
  /** Multi-turn side-panel chat, optionally grounded in a page/workspace. */
  converse(args: {
    messages: AiChatTurn[];
    pageId?: PageId;
    useWorkspace?: boolean;
    persona?: string;
  }): Promise<AiAnswer>;
  /** Markdown slide outline for "Create a slide deck". */
  deckOutline(args: { pageId?: PageId; topic?: string }): Promise<string>;
}

export interface AccountApi {
  /** False in mock mode and while offline — the sections hide themselves. */
  available: boolean;
  /** Owner email for display + Touch ID re-enrollment after a change. */
  getEmail(): Promise<string | null>;
  /** Re-verifies the current password server-side before changing. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** Revokes every session on every device. */
  signOutEverywhere(): Promise<void>;
  /** Password-gated: erases the workspace and the account entirely. */
  deleteAccount(password: string): Promise<void>;
}

export interface PublishApi {
  /** False while offline: publishing is a server-authoritative action. */
  available: boolean;
  /** Returns the new slug, or null when unpublishing. */
  set(pageId: PageId, value: boolean): Promise<string | null>;
  /** Public URL for a slug, or null if the deployment URL is unknown. */
  urlFor(slug: string): string | null;
}

export interface VersionHistoryApi {
  available: boolean;
  list(pageId: PageId): Promise<VersionMeta[]>;
  get(id: string): Promise<VersionDoc | null>;
}

export interface CommentsApi {
  /** False while offline: comments live in a table the replica never mirrors. */
  available: boolean;
  list(pageId: PageId): Promise<CommentMeta[]>;
  add(pageId: PageId, text: string): Promise<void>;
  setResolved(id: string, value: boolean): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface Mutations {
  create(args: {
    parentId?: PageId;
    type: "doc" | "database";
    title?: string;
    icon?: string;
    props?: Record<string, unknown>;
    /** Creating the vault root. Children inherit membership server-side. */
    vault?: boolean;
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
  /** Replace a database's saved views (whole array — see convex setViews). */
  setViews(args: { id: PageId; views: DbView[] }): Promise<void>;
  bootstrap(): Promise<PageId | null>;
}

/**
 * Origin that published `/p/<slug>` links are minted from.
 *
 * Published pages are served by Convex HTTP actions, which live on the `.site`
 * domain rather than the `.cloud` one the client talks to — so
 * `VITE_CONVEX_SITE_URL` is the natural default and stays correct for a plain
 * Convex-hosted setup.
 *
 * `VITE_PUBLIC_SITE_URL` overrides it so links can be minted on the app's own
 * domain instead, with the host proxying `/p/*` through to Convex (see the
 * rewrite in vercel.json). It is a **separate variable on purpose**:
 * `npx convex deploy --cmd` injects `VITE_CONVEX_SITE_URL` into the build
 * environment, and a real process env var outranks `.env.production` in Vite,
 * so overriding that name would work locally and be silently reverted in CI.
 */
export function publicUrlFor(slug: string): string | null {
  const site =
    import.meta.env.VITE_PUBLIC_SITE_URL ?? import.meta.env.VITE_CONVEX_SITE_URL;
  if (!site) return null;
  return `${site.replace(/\/$/, "")}/p/${slug}`;
}

export const IS_MOCK = import.meta.env.VITE_MOCK_CONVEX === "1";
export const IS_DIRECT = import.meta.env.VITE_DIRECT_CONVEX === "1";
