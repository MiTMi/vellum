import { query } from "./_generated/server";
import { v } from "convex/values";
import { MAX_VERSIONS_PER_PAGE } from "./lib/versions";

/**
 * Page history reads. Snapshots are written by pages.updateContent; these
 * queries only read them, so offline clients can call them straight through
 * the Convex client (no replica involvement) when connected.
 */

/** Snapshot metadata for a page, newest first. Content omitted — it's big. */
export const list = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pageVersions")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(MAX_VERSIONS_PER_PAGE);
    return rows.map((r) => ({
      _id: r._id,
      title: r.title,
      savedAt: r.savedAt,
    }));
  },
});

/** One snapshot including its full content (for preview / restore). */
export const get = query({
  args: { id: v.id("pageVersions") },
  handler: async (ctx, args) => {
    return await ctx.db.get("pageVersions", args.id);
  },
});
