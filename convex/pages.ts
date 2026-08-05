import {
  query,
  mutation,
  internalQuery,
  MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { Id, Doc } from "./_generated/dataModel";
import { activeView, dbProp } from "./schema";
import { requireUser } from "./lib/auth";
import { extractPageLinks } from "./lib/pageLinks";
import { makeSnippet } from "./lib/snippet";
import {
  MAX_VERSIONS_PER_PAGE,
  shouldSnapshot,
} from "./lib/versions";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function childrenOf(ctx: MutationCtx, parentId: Id<"pages">) {
  return await ctx.db
    .query("pages")
    .withIndex("by_parent", (q) => q.eq("parentId", parentId))
    .collect();
}

async function nextRank(ctx: MutationCtx, parentId: Id<"pages"> | undefined) {
  const siblings = await ctx.db
    .query("pages")
    .withIndex("by_parent", (q) => q.eq("parentId", parentId))
    .collect();
  let max = 0;
  for (const s of siblings) if (s.rank > max) max = s.rank;
  return max + 1024;
}

/** Delete every history snapshot and comment belonging to a page. */
async function deleteSidecarsOf(ctx: MutationCtx, pageId: Id<"pages">) {
  const versions = await ctx.db
    .query("pageVersions")
    .withIndex("by_page", (q) => q.eq("pageId", pageId))
    .collect();
  for (const v of versions) await ctx.db.delete("pageVersions", v._id);
  const comments = await ctx.db
    .query("comments")
    .withIndex("by_page", (q) => q.eq("pageId", pageId))
    .collect();
  for (const c of comments) await ctx.db.delete("comments", c._id);
}

async function forSubtree(
  ctx: MutationCtx,
  rootId: Id<"pages">,
  fn: (page: Doc<"pages">) => Promise<void>,
) {
  const root = await ctx.db.get("pages", rootId);
  if (!root) return;
  await fn(root);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const kids = await childrenOf(ctx, id);
    for (const kid of kids) {
      await fn(kid);
      stack.push(kid._id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** Lightweight listing of every live page — the client builds the tree. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const pages = await ctx.db.query("pages").collect();
    return pages
      .filter((p) => !p.inTrash)
      .map((p) => ({
        _id: p._id,
        title: p.title,
        type: p.type,
        parentId: p.parentId ?? null,
        rank: p.rank,
        icon: p.icon ?? null,
        cover: p.cover ?? null,
        isFavorite: p.isFavorite ?? false,
        isTemplate: p.isTemplate ?? false,
        vault: p.vault ?? false,
        props: p.props ?? null,
        updatedAt: p.updatedAt,
        _creationTime: p._creationTime,
      }));
  },
});

/** Full page document (editor content, cover, db schema, …). */
export const get = query({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get("pages", args.id);
  },
});

export const trashed = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const pages = await ctx.db.query("pages").collect();
    return pages
      .filter((p) => p.inTrash && p.trashRoot)
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
      .map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon ?? null,
        type: p.type,
        vault: p.vault ?? false,
        trashedAt: p.trashedAt ?? 0,
      }));
  },
});

/**
 * Sync index for offline clients: every page (trashed included) with its
 * updatedAt. Clients diff this against their local replica; absence here
 * means the page was permanently deleted.
 */
export const syncIndex = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const pages = await ctx.db.query("pages").collect();
    return pages.map((p) => ({ _id: p._id, updatedAt: p.updatedAt }));
  },
});

/** Batched full-doc fetch for the sync engine's pull path. */
export const getMany = query({
  args: { ids: v.array(v.id("pages")) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const docs: Doc<"pages">[] = [];
    for (const id of args.ids) {
      const doc = await ctx.db.get("pages", id);
      if (doc) docs.push(doc);
    }
    return docs;
  },
});

/** Pages whose content links to this page ("Linked mentions" in the UI). */
export const backlinks = query({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const pages = await ctx.db.query("pages").collect();
    return pages
      .filter(
        (p) =>
          !p.inTrash &&
          p._id !== args.id &&
          extractPageLinks(p.content).includes(args.id),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon ?? null,
        type: p.type,
      }));
  },
});

export const search = query({
  args: { term: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (!args.term.trim()) return [];
    const results = await ctx.db
      .query("pages")
      .withSearchIndex("search", (q) => q.search("searchText", args.term))
      .take(20);
    return results
      // Vault pages are excluded defensively: their searchText is written
      // empty (their plaintext never reaches the server), so nothing should
      // match — but an encrypted page must never surface in results.
      .filter((p) => !p.inTrash && !p.vault)
      .map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon ?? null,
        type: p.type,
        parentId: p.parentId ?? null,
        snippet: makeSnippet(p.contentText, args.term),
      }));
  },
});

/* ------------------------------------------------------------------ */
/* Create / update                                                     */
/* ------------------------------------------------------------------ */

export const create = mutation({
  args: {
    parentId: v.optional(v.id("pages")),
    type: v.union(v.literal("doc"), v.literal("database")),
    title: v.optional(v.string()),
    icon: v.optional(v.string()),
    props: v.optional(v.record(v.string(), v.any())),
    // True only when creating the vault root itself; children inherit below.
    vault: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    // Vault membership is inherited server-side so a buggy client can't
    // create a plaintext-indexed page inside the encrypted subtree.
    const parent = args.parentId ? await ctx.db.get("pages", args.parentId) : null;
    const vault = args.vault || parent?.vault ? true : undefined;
    if (vault && args.type === "database") {
      throw new Error("Databases inside the Vault are not supported yet");
    }
    const rank = await nextRank(ctx, args.parentId);
    const now = Date.now();
    const id = await ctx.db.insert("pages", {
      title: args.title ?? "",
      type: args.type,
      parentId: args.parentId,
      rank,
      icon: args.icon,
      props: args.props,
      vault,
      searchText: vault ? "" : (args.title ?? ""),
      updatedAt: now,
      ...(args.type === "database"
        ? {
            dbProps: [
              { id: "status", name: "Status", type: "select" as const, options: [
                { id: "todo", name: "Not started", color: "gray" },
                { id: "doing", name: "In progress", color: "blue" },
                { id: "done", name: "Done", color: "green" },
              ] },
              { id: "tags", name: "Tags", type: "multiSelect" as const, options: [] },
              { id: "date", name: "Date", type: "date" as const },
            ],
            activeView: "table" as const,
            boardGroupBy: "status",
          }
        : {}),
    });
    return id;
  },
});

/**
 * Replay of an offline-created page, full doc included. Idempotent via
 * `clientKey` (the creating client's temp id): a crash between send and
 * ack just returns the already-inserted page on retry.
 */
export const createWithDoc = mutation({
  args: {
    clientKey: v.string(),
    title: v.string(),
    type: v.union(v.literal("doc"), v.literal("database")),
    parentId: v.optional(v.id("pages")),
    rank: v.number(),
    icon: v.optional(v.string()),
    cover: v.optional(v.string()),
    content: v.optional(v.any()),
    contentText: v.optional(v.string()),
    searchText: v.optional(v.string()),
    props: v.optional(v.record(v.string(), v.any())),
    isFavorite: v.optional(v.boolean()),
    isTemplate: v.optional(v.boolean()),
    font: v.optional(
      v.union(v.literal("default"), v.literal("serif"), v.literal("mono")),
    ),
    smallText: v.optional(v.boolean()),
    fullWidth: v.optional(v.boolean()),
    locked: v.optional(v.boolean()),
    vault: v.optional(v.boolean()),
    inTrash: v.optional(v.boolean()),
    trashRoot: v.optional(v.boolean()),
    trashedAt: v.optional(v.number()),
    dbProps: v.optional(v.array(dbProp)),
    activeView: v.optional(activeView),
    boardGroupBy: v.optional(v.string()),
    calendarBy: v.optional(v.string()),
    updatedAt: v.number(),
    // Accepted so a stray value can't make the validator reject the whole
    // replay forever (see the createWithDoc invariant in CLAUDE.md), but
    // dropped below: publishing is server-authoritative and a page created
    // offline is never already public.
    publicSlug: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db
      .query("pages")
      .withIndex("by_clientKey", (q) => q.eq("clientKey", args.clientKey))
      .unique();
    if (existing) return existing._id;
    const { clientKey, publicSlug, publishedAt, ...doc } = args;
    // Same server-side vault inheritance as `create`, plus: an encrypted
    // page must never contribute plaintext to the search index.
    const parent = doc.parentId ? await ctx.db.get("pages", doc.parentId) : null;
    const vault = doc.vault || parent?.vault ? true : undefined;
    return await ctx.db.insert("pages", {
      ...doc,
      vault,
      contentText: vault ? "" : doc.contentText,
      searchText: vault ? "" : doc.searchText,
      clientKey,
      contentUpdatedAt: args.updatedAt,
    });
  },
});

export const rename = mutation({
  args: {
    id: v.id("pages"),
    title: v.string(),
    // Wall-clock time of the local edit, sent by offline clients for
    // last-writer-wins: an older replayed edit must not clobber a newer one.
    clientUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    if (
      args.clientUpdatedAt !== undefined &&
      page.contentUpdatedAt !== undefined &&
      args.clientUpdatedAt < page.contentUpdatedAt
    ) {
      return;
    }
    const now = args.clientUpdatedAt ?? Date.now();
    await ctx.db.patch("pages", args.id, {
      title: args.title,
      // Vault titles arrive encrypted — keep them out of the search index.
      searchText: page.vault ? "" : args.title + " " + (page.contentText ?? ""),
      updatedAt: now,
      contentUpdatedAt: now,
    });
  },
});

/** Persist editor content. `text` is the plain-text extraction for search. */
export const updateContent = mutation({
  args: {
    id: v.id("pages"),
    content: v.any(),
    text: v.string(),
    clientUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    if (
      args.clientUpdatedAt !== undefined &&
      page.contentUpdatedAt !== undefined &&
      args.clientUpdatedAt < page.contentUpdatedAt
    ) {
      return;
    }
    const now = args.clientUpdatedAt ?? Date.now();

    // Snapshot the *previous* content before overwriting it, at most once
    // per SNAPSHOT_INTERVAL_MS — so a typing session leaves one restorable
    // version, not thousands.
    if (page.content !== undefined) {
      const latest = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", args.id))
        .order("desc")
        .first();
      if (shouldSnapshot(latest?.savedAt, now)) {
        await ctx.db.insert("pageVersions", {
          pageId: args.id,
          title: page.title,
          content: page.content,
          savedAt: now,
        });
        const all = await ctx.db
          .query("pageVersions")
          .withIndex("by_page", (q) => q.eq("pageId", args.id))
          .collect();
        if (all.length > MAX_VERSIONS_PER_PAGE) {
          // `by_page` is ordered [pageId, savedAt] ascending → oldest first.
          for (const stale of all.slice(0, all.length - MAX_VERSIONS_PER_PAGE)) {
            await ctx.db.delete("pageVersions", stale._id);
          }
        }
      }
    }

    await ctx.db.patch("pages", args.id, {
      content: args.content,
      // Vault content arrives encrypted with an empty `text` — never let
      // either search field hold vault plaintext (or ciphertext).
      contentText: page.vault ? "" : args.text,
      searchText: page.vault ? "" : page.title + " " + args.text,
      updatedAt: now,
      contentUpdatedAt: now,
    });
  },
});

export const setIcon = mutation({
  args: { id: v.id("pages"), icon: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      icon: args.icon === null ? undefined : args.icon,
      updatedAt: Date.now(),
    });
  },
});

export const setCover = mutation({
  args: { id: v.id("pages"), cover: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      cover: args.cover === null ? undefined : args.cover,
      updatedAt: Date.now(),
    });
  },
});

/** Page display options: font, small text, full width, lock. */
export const setPageOptions = mutation({
  args: {
    id: v.id("pages"),
    font: v.optional(
      v.union(v.literal("default"), v.literal("serif"), v.literal("mono")),
    ),
    smallText: v.optional(v.boolean()),
    fullWidth: v.optional(v.boolean()),
    locked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.font !== undefined) patch.font = args.font;
    if (args.smallText !== undefined) patch.smallText = args.smallText;
    if (args.fullWidth !== undefined) patch.fullWidth = args.fullWidth;
    if (args.locked !== undefined) patch.locked = args.locked;
    await ctx.db.patch("pages", args.id, patch);
  },
});

export const toggleFavorite = mutation({
  args: {
    id: v.id("pages"),
    // Absolute value sent by offline replays — a replayed toggle must not
    // flip state that already matches.
    value: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      isFavorite: args.value ?? !page.isFavorite,
      updatedAt: Date.now(),
    });
  },
});

export const setTemplate = mutation({
  args: {
    id: v.id("pages"),
    // Absolute, like toggleFavorite's `value` — replays must be idempotent.
    value: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      isTemplate: args.value,
      updatedAt: Date.now(),
    });
  },
});

/* ------------------------------------------------------------------ */
/* Move / duplicate                                                    */
/* ------------------------------------------------------------------ */

export const move = mutation({
  args: {
    id: v.id("pages"),
    parentId: v.optional(v.id("pages")),
    rank: v.number(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (args.parentId) {
      // Prevent moving a page inside its own subtree.
      let cursor: Id<"pages"> | undefined = args.parentId;
      while (cursor) {
        if (cursor === args.id) return;
        const p: Doc<"pages"> | null = await ctx.db.get("pages", cursor);
        cursor = p?.parentId;
      }
    }
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    // The vault boundary is not crossable by moving: a plaintext page can't
    // land inside the encrypted subtree (it would be unreadable there and
    // its history would stay plaintext), and an encrypted page can't leave
    // it (it would be undecryptable ciphertext outside). The vault *root*
    // sits at the boundary by definition and may move anywhere (it drags
    // its subtree along), so only its descendants are pinned.
    const newParent = args.parentId
      ? await ctx.db.get("pages", args.parentId)
      : null;
    const oldParent = page.parentId
      ? await ctx.db.get("pages", page.parentId)
      : null;
    const isVaultRoot = (page.vault ?? false) && !(oldParent?.vault ?? false);
    if (!isVaultRoot) {
      if ((page.vault ?? false) !== (newParent?.vault ?? false)) {
        throw new Error("Pages can't move into or out of the Vault");
      }
    } else if (newParent?.vault) {
      throw new Error("The Vault can't be moved inside itself");
    }
    await ctx.db.patch("pages", args.id, {
      parentId: args.parentId,
      rank: args.rank,
      updatedAt: Date.now(),
    });
  },
});

export const duplicate = mutation({
  args: {
    id: v.id("pages"),
    /** Destination parent. Omitted → alongside the source. */
    parentId: v.optional(v.id("pages")),
    /** Title suffix for the root copy. Defaults to " (copy)". */
    suffix: v.optional(v.string()),
    /**
     * Spawning a page *from* a template: the root copy is a normal page
     * (isTemplate cleared) rather than another template.
     */
    asInstance: v.optional(v.boolean()),
    /** Explicit destination for the copy. Only used with `parentId`. */
    toRoot: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const src = await ctx.db.get("pages", args.id);
    if (!src) return null;

    const reparent = args.parentId !== undefined || args.toRoot === true;
    const destParent = args.parentId;
    const destRank = reparent
      ? await nextRank(ctx, destParent)
      : src.rank + 1;

    // Vault guards. The root can't be duplicated (two roots would be
    // ambiguous); descendants only duplicate within the vault, and
    // plaintext pages never duplicate into it.
    const srcParent = src.parentId
      ? await ctx.db.get("pages", src.parentId)
      : null;
    if ((src.vault ?? false) && !(srcParent?.vault ?? false)) {
      throw new Error("The Vault itself can't be duplicated");
    }
    const destParentDoc = destParent
      ? await ctx.db.get("pages", destParent)
      : null;
    const destVault = reparent
      ? (destParentDoc?.vault ?? false)
      : (srcParent?.vault ?? false);
    if ((src.vault ?? false) !== destVault) {
      throw new Error("Pages can't be duplicated into or out of the Vault");
    }

    // An encrypted title can't take a " (copy)" suffix — it would corrupt
    // the envelope. Vault copies keep their title verbatim.
    const suffix = src.vault ? "" : (args.suffix ?? " (copy)");

    async function clone(
      page: Doc<"pages">,
      parentId: Id<"pages"> | undefined,
      rank: number,
      titleSuffix: string,
      isRoot: boolean,
    ): Promise<Id<"pages">> {
      // clientKey must stay unique per created page — never copy it.
      // publicSlug/publishedAt must not be copied either: the slug is the
      // access control for /p/<slug>, and two pages sharing one would both
      // leak the copy and break the unique bySlug lookup.
      const { _id, _creationTime, clientKey, publicSlug, publishedAt, ...rest } =
        page;
      const newId = await ctx.db.insert("pages", {
        ...rest,
        parentId,
        rank,
        title: page.title + titleSuffix,
        isFavorite: false,
        ...(isRoot && args.asInstance ? { isTemplate: undefined } : {}),
        updatedAt: Date.now(),
      });
      const kids = await childrenOf(ctx, page._id);
      kids.sort((a, b) => a.rank - b.rank);
      for (const kid of kids) {
        await clone(kid, newId, kid.rank, "", false);
      }
      return newId;
    }

    return await clone(
      src,
      reparent ? destParent : src.parentId,
      destRank,
      suffix,
      true,
    );
  },
});

/* ------------------------------------------------------------------ */
/* Trash                                                               */
/* ------------------------------------------------------------------ */

export const trash = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const now = Date.now();
    await forSubtree(ctx, args.id, async (page) => {
      await ctx.db.patch("pages", page._id, {
        inTrash: true,
        trashRoot: page._id === args.id,
        trashedAt: now,
        isFavorite: false,
        updatedAt: now,
      });
    });
  },
});

export const restore = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    // If the original parent is gone or still in the trash, restore to root.
    let parentId = page.parentId;
    if (parentId) {
      const parent = await ctx.db.get("pages", parentId);
      if (!parent || parent.inTrash) parentId = undefined;
    }
    await forSubtree(ctx, args.id, async (p) => {
      await ctx.db.patch("pages", p._id, {
        inTrash: undefined,
        trashRoot: undefined,
        trashedAt: undefined,
        updatedAt: Date.now(),
      });
    });
    await ctx.db.patch("pages", args.id, { parentId });
  },
});

export const deleteForever = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const ids: Id<"pages">[] = [];
    await forSubtree(ctx, args.id, async (p) => {
      ids.push(p._id);
    });
    for (const id of ids) {
      await deleteSidecarsOf(ctx, id);
      await ctx.db.delete("pages", id);
    }
  },
});

export const emptyTrash = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const pages = await ctx.db.query("pages").collect();
    for (const p of pages) {
      if (p.inTrash) {
        await deleteSidecarsOf(ctx, p._id);
        await ctx.db.delete("pages", p._id);
      }
    }
  },
});

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

export const updateDbProps = mutation({
  args: { id: v.id("pages"), dbProps: v.array(dbProp) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      dbProps: args.dbProps,
      updatedAt: Date.now(),
    });
  },
});

export const setRowProp = mutation({
  args: { id: v.id("pages"), propId: v.string(), value: v.any() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    const props = { ...(page.props ?? {}) };
    if (args.value === null) delete props[args.propId];
    else props[args.propId] = args.value;
    await ctx.db.patch("pages", args.id, { props, updatedAt: Date.now() });
  },
});

export const setView = mutation({
  args: {
    id: v.id("pages"),
    activeView: v.optional(activeView),
    boardGroupBy: v.optional(v.string()),
    calendarBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.activeView !== undefined) patch.activeView = args.activeView;
    if (args.boardGroupBy !== undefined) patch.boardGroupBy = args.boardGroupBy;
    if (args.calendarBy !== undefined) patch.calendarBy = args.calendarBy;
    await ctx.db.patch("pages", args.id, patch);
  },
});

/* ------------------------------------------------------------------ */
/* Bootstrap — seed a welcoming workspace on first launch              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Publish to web                                                      */
/* ------------------------------------------------------------------ */

/**
 * The slug is the whole access control for a published page, so it has to be
 * unguessable. 20 base-36 chars ≈ 103 bits.
 */
function newPublicSlug(): string {
  let out = "";
  while (out.length < 20) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, 20);
}

/** Publish or unpublish. Unpublishing clears the slug, killing the old URL. */
export const setPublished = mutation({
  args: { id: v.id("pages"), value: v.boolean() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const page = await ctx.db.get("pages", args.id);
    if (!page) return null;

    // The Vault's contract is absolute: its pages are ciphertext to the
    // server and can never be made public. (The client hides the toggle;
    // this is the authoritative guard.)
    if (page.vault) {
      throw new Error("Vault pages can't be published");
    }

    if (!args.value) {
      await ctx.db.patch("pages", args.id, {
        publicSlug: undefined,
        publishedAt: undefined,
        updatedAt: Date.now(),
      });
      return null;
    }

    // Publishing an already-published page is a no-op rather than a re-roll,
    // so a double-click can't invalidate a link that's already been shared.
    // (Unpublishing *does* drop the slug, so publish-after-unpublish mints a
    // new one and the revoked URL stays dead — that's the intended contract.)
    const slug = page.publicSlug ?? newPublicSlug();
    await ctx.db.patch("pages", args.id, {
      publicSlug: slug,
      publishedAt: page.publishedAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    return slug;
  },
});

/**
 * Read a page by its public slug. Internal on purpose: it deliberately skips
 * `requireUser`, so it must be reachable only from the HTTP action that
 * serves published pages — never from a client.
 */
export const bySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    if (!args.slug) return null;
    const page = await ctx.db
      .query("pages")
      .withIndex("by_publicSlug", (q) => q.eq("publicSlug", args.slug))
      .unique();
    // A trashed page stops being public even though the slug survives, so
    // that restoring it doesn't silently re-expose it under a stale link.
    if (!page || page.inTrash) return null;

    // Titles for sub-page links/mentions — the renderer prints titles only,
    // never ids or URLs, so this leaks nothing beyond what the author wrote.
    const titles: Record<string, string> = {};
    for (const id of extractPageLinks(page.content)) {
      const linked = await ctx.db.get("pages", id as Id<"pages">);
      if (linked) titles[id] = linked.title;
    }

    return {
      title: page.title,
      icon: page.icon ?? null,
      content: page.content ?? [],
      updatedAt: page.updatedAt,
      titles,
    };
  },
});

export const bootstrap = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const existing = await ctx.db.query("pages").first();
    if (existing) return null;
    const now = Date.now();
    const welcome = await ctx.db.insert("pages", {
      title: "Welcome to Vellum",
      type: "doc",
      rank: 1024,
      icon: "👋",
      cover: "gradient:4",
      updatedAt: now,
      searchText: "Welcome to Vellum",
      content: [
        { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Your workspace, your rules", styles: {} }] },
        { type: "paragraph", content: [{ type: "text", text: "Vellum is your personal Notion-style workspace. Everything you write is saved instantly to your Convex database.", styles: {} }] },
        { type: "paragraph", content: [] },
        { type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Things to try", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Type ", styles: {} }, { type: "text", text: "/", styles: { code: true } }, { type: "text", text: " anywhere to insert headings, tables, images, and more", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Press ", styles: {} }, { type: "text", text: "⌘K", styles: { code: true } }, { type: "text", text: " to search and jump between pages", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Hover the page title to add an icon or a cover", styles: {} }] },
        { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Create a database from the sidebar — tables and boards included", styles: {} }] },
        { type: "paragraph", content: [] },
        { type: "quote", content: [{ type: "text", text: "Drag pages in the sidebar to nest them, star the ones you love, and everything else works the way you'd expect.", styles: {} }] },
      ],
    });
    return welcome;
  },
});
