import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Page comments.
 *
 * Deliberately do NOT bump the page's `updatedAt`: comments aren't page
 * content, and churning that timestamp would make every comment look like an
 * edit to reconcile (and to last-writer-wins).
 */

const MAX_COMMENTS = 200;

export const list = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("comments")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .take(MAX_COMMENTS);
  },
});

export const add = mutation({
  args: { pageId: v.id("pages"), text: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) return null;
    // Replayed/raced writes must not resurrect a comment on a deleted page.
    const page = await ctx.db.get("pages", args.pageId);
    if (!page) return null;
    return await ctx.db.insert("comments", {
      pageId: args.pageId,
      text: text.slice(0, 5000),
      createdAt: Date.now(),
    });
  },
});

export const setResolved = mutation({
  // Absolute, not a toggle — matches the convention every other mutation
  // here follows, so a double-send can't flip it back.
  args: { id: v.id("comments"), value: v.boolean() },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get("comments", args.id);
    if (!comment) return;
    await ctx.db.patch("comments", args.id, { resolved: args.value });
  },
});

export const remove = mutation({
  args: { id: v.id("comments") },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get("comments", args.id);
    if (!comment) return;
    await ctx.db.delete("comments", args.id);
  },
});
