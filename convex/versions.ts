import { query } from "./_generated/server";
import { v } from "convex/values";
import { readOwnedPage, requireUser } from "./lib/auth";
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
    const userId = await requireUser(ctx);
    // History belongs to the page's owner; foreign pages read as empty.
    if (!(await readOwnedPage(ctx, userId, args.pageId))) return [];
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
    const userId = await requireUser(ctx);
    const version = await ctx.db.get("pageVersions", args.id);
    if (!version) return null;
    // Ownership flows through the page (covers pre-backfill snapshots
    // whose own ownerId is still unset).
    if (!(await readOwnedPage(ctx, userId, version.pageId))) return null;
    return version;
  },
});
