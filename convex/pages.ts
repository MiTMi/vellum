import { query, mutation, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { Id, Doc } from "./_generated/dataModel";
import { dbProp } from "./schema";

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
        isFavorite: p.isFavorite ?? false,
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
    return await ctx.db.get("pages", args.id);
  },
});

export const trashed = query({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db.query("pages").collect();
    return pages
      .filter((p) => p.inTrash && p.trashRoot)
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
      .map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon ?? null,
        type: p.type,
        trashedAt: p.trashedAt ?? 0,
      }));
  },
});

export const search = query({
  args: { term: v.string() },
  handler: async (ctx, args) => {
    if (!args.term.trim()) return [];
    const results = await ctx.db
      .query("pages")
      .withSearchIndex("search", (q) => q.search("searchText", args.term))
      .take(20);
    return results
      .filter((p) => !p.inTrash)
      .map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon ?? null,
        type: p.type,
        parentId: p.parentId ?? null,
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
  },
  handler: async (ctx, args) => {
    const rank = await nextRank(ctx, args.parentId);
    const now = Date.now();
    const id = await ctx.db.insert("pages", {
      title: args.title ?? "",
      type: args.type,
      parentId: args.parentId,
      rank,
      icon: args.icon,
      props: args.props,
      searchText: args.title ?? "",
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

export const rename = mutation({
  args: { id: v.id("pages"), title: v.string() },
  handler: async (ctx, args) => {
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      title: args.title,
      searchText: args.title + " " + (page.contentText ?? ""),
      updatedAt: Date.now(),
    });
  },
});

/** Persist editor content. `text` is the plain-text extraction for search. */
export const updateContent = mutation({
  args: { id: v.id("pages"), content: v.any(), text: v.string() },
  handler: async (ctx, args) => {
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, {
      content: args.content,
      contentText: args.text,
      searchText: page.title + " " + args.text,
      updatedAt: Date.now(),
    });
  },
});

export const setIcon = mutation({
  args: { id: v.id("pages"), icon: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    await ctx.db.patch("pages", args.id, {
      icon: args.icon === null ? undefined : args.icon,
      updatedAt: Date.now(),
    });
  },
});

export const setCover = mutation({
  args: { id: v.id("pages"), cover: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
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
    const patch: Record<string, unknown> = {};
    if (args.font !== undefined) patch.font = args.font;
    if (args.smallText !== undefined) patch.smallText = args.smallText;
    if (args.fullWidth !== undefined) patch.fullWidth = args.fullWidth;
    if (args.locked !== undefined) patch.locked = args.locked;
    await ctx.db.patch("pages", args.id, patch);
  },
});

export const toggleFavorite = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    const page = await ctx.db.get("pages", args.id);
    if (!page) return;
    await ctx.db.patch("pages", args.id, { isFavorite: !page.isFavorite });
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
    if (args.parentId) {
      // Prevent moving a page inside its own subtree.
      let cursor: Id<"pages"> | undefined = args.parentId;
      while (cursor) {
        if (cursor === args.id) return;
        const p: Doc<"pages"> | null = await ctx.db.get("pages", cursor);
        cursor = p?.parentId;
      }
    }
    await ctx.db.patch("pages", args.id, {
      parentId: args.parentId,
      rank: args.rank,
    });
  },
});

export const duplicate = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    const src = await ctx.db.get("pages", args.id);
    if (!src) return null;

    async function clone(
      page: Doc<"pages">,
      parentId: Id<"pages"> | undefined,
      rank: number,
      titleSuffix: string,
    ): Promise<Id<"pages">> {
      const { _id, _creationTime, ...rest } = page;
      const newId = await ctx.db.insert("pages", {
        ...rest,
        parentId,
        rank,
        title: page.title + titleSuffix,
        isFavorite: false,
        updatedAt: Date.now(),
      });
      const kids = await childrenOf(ctx, page._id);
      kids.sort((a, b) => a.rank - b.rank);
      for (const kid of kids) {
        await clone(kid, newId, kid.rank, "");
      }
      return newId;
    }

    return await clone(src, src.parentId, src.rank + 1, " (copy)");
  },
});

/* ------------------------------------------------------------------ */
/* Trash                                                               */
/* ------------------------------------------------------------------ */

export const trash = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    const now = Date.now();
    await forSubtree(ctx, args.id, async (page) => {
      await ctx.db.patch("pages", page._id, {
        inTrash: true,
        trashRoot: page._id === args.id,
        trashedAt: now,
        isFavorite: false,
      });
    });
  },
});

export const restore = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
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
      });
    });
    await ctx.db.patch("pages", args.id, { parentId });
  },
});

export const deleteForever = mutation({
  args: { id: v.id("pages") },
  handler: async (ctx, args) => {
    const ids: Id<"pages">[] = [];
    await forSubtree(ctx, args.id, async (p) => {
      ids.push(p._id);
    });
    for (const id of ids) await ctx.db.delete("pages", id);
  },
});

export const emptyTrash = mutation({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db.query("pages").collect();
    for (const p of pages) {
      if (p.inTrash) await ctx.db.delete("pages", p._id);
    }
  },
});

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

export const updateDbProps = mutation({
  args: { id: v.id("pages"), dbProps: v.array(dbProp) },
  handler: async (ctx, args) => {
    await ctx.db.patch("pages", args.id, {
      dbProps: args.dbProps,
      updatedAt: Date.now(),
    });
  },
});

export const setRowProp = mutation({
  args: { id: v.id("pages"), propId: v.string(), value: v.any() },
  handler: async (ctx, args) => {
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
    activeView: v.optional(
      v.union(v.literal("table"), v.literal("board"), v.literal("calendar")),
    ),
    boardGroupBy: v.optional(v.string()),
    calendarBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.activeView !== undefined) patch.activeView = args.activeView;
    if (args.boardGroupBy !== undefined) patch.boardGroupBy = args.boardGroupBy;
    if (args.calendarBy !== undefined) patch.calendarBy = args.calendarBy;
    await ctx.db.patch("pages", args.id, patch);
  },
});

/* ------------------------------------------------------------------ */
/* Bootstrap — seed a welcoming workspace on first launch              */
/* ------------------------------------------------------------------ */

export const bootstrap = mutation({
  args: {},
  handler: async (ctx) => {
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
