import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { aiThreadMessage } from "./lib/aiThreadShape";

/**
 * Saved AI chats (2026-09-22). One document per thread, owner-only, never
 * shared: a chat can quote any page its owner can read, so exposing it to a
 * sharee would leak across the share boundary. Same null/throw contract as
 * pages — reads of a foreign id return null, writes throw.
 */

/** Kept per thread: enough to scroll back through a long session. */
const MAX_MESSAGES = 60;
/** Well under the 1 MB document limit, leaving room for the other fields. */
const MAX_THREAD_CHARS = 800_000;
const MAX_TITLE_CHARS = 80;
/** Threads listed in the history menu. */
const LIST_LIMIT = 30;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("aiThreads")
      .withIndex("by_owner_updated", (q) => q.eq("ownerId", userId))
      .order("desc")
      .take(LIST_LIMIT);
    return rows.map((t) => ({
      _id: t._id,
      title: t.title,
      updatedAt: t.updatedAt,
      messageCount: t.messages.length,
    }));
  },
});

export const get = query({
  args: { id: v.id("aiThreads") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const t = await ctx.db.get("aiThreads", args.id);
    if (!t || t.ownerId !== userId) return null;
    return { _id: t._id, title: t.title, messages: t.messages, updatedAt: t.updatedAt };
  },
});

/**
 * Upsert the whole thread (absolute-valued, like every replayable write).
 * An unknown id — deleted from another tab, say — starts a new thread
 * rather than losing the conversation; a foreign id throws.
 */
export const save = mutation({
  args: {
    id: v.optional(v.id("aiThreads")),
    title: v.string(),
    messages: v.array(aiThreadMessage),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    let messages = args.messages.slice(-MAX_MESSAGES);
    while (messages.length > 1 && JSON.stringify(messages).length > MAX_THREAD_CHARS) {
      messages = messages.slice(1);
    }
    const title = args.title.trim().slice(0, MAX_TITLE_CHARS) || "Untitled chat";
    const now = Date.now();
    if (args.id) {
      const existing = await ctx.db.get("aiThreads", args.id);
      if (existing) {
        if (existing.ownerId !== userId) throw new ConvexError("Not authorized");
        await ctx.db.patch("aiThreads", args.id, { title, messages, updatedAt: now });
        return args.id;
      }
    }
    return await ctx.db.insert("aiThreads", {
      ownerId: userId,
      title,
      messages,
      updatedAt: now,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("aiThreads") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const t = await ctx.db.get("aiThreads", args.id);
    if (!t) return;
    if (t.ownerId !== userId) throw new ConvexError("Not authorized");
    await ctx.db.delete("aiThreads", args.id);
  },
});
