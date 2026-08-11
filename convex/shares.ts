import { v, ConvexError } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { readOwnedPage, requireUser, writeOwnedPage } from "./lib/auth";

/**
 * Share management (Phase 2, docs/phase2-sharing-design.md). Every
 * function here is owner-side: only a page's owner may grant, change, or
 * revoke access, and `writeOwnedPage` (loud throw on foreign) is what
 * enforces it. Recipients consume shares through `pages.syncIndex` /
 * `getAccessiblePage`, not this module — except `listSharedWithMe`,
 * which feeds the Library's Shared tab.
 */

const role = v.union(v.literal("viewer"), v.literal("editor"));

/** Exact-match email lookup; no autocomplete, no enumeration surface. */
async function userByEmail(
  ctx: QueryCtx,
  email: string,
): Promise<Doc<"users"> | null> {
  const normalized = email.trim();
  const exact = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", normalized))
    .first();
  if (exact) return exact;
  return await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", normalized.toLowerCase()))
    .first();
}

/** Grant or update access. Owner-only; vault pages are never shareable. */
export const add = mutation({
  args: { pageId: v.id("pages"), email: v.string(), role },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const page = await writeOwnedPage(ctx, userId, args.pageId);
    if (!page) throw new ConvexError("Page not found");
    if (page.vault) {
      throw new ConvexError("Vault pages are end-to-end encrypted and can't be shared.");
    }
    const recipient = await userByEmail(ctx, args.email);
    if (!recipient) {
      throw new ConvexError("No Vellum account with that email.");
    }
    if (recipient._id === userId) {
      throw new ConvexError("That's you — you already have access.");
    }
    const existing = await ctx.db
      .query("shares")
      .withIndex("by_page_user", (q) =>
        q.eq("pageId", args.pageId).eq("userId", recipient._id),
      )
      .unique();
    if (existing) {
      await ctx.db.patch("shares", existing._id, { role: args.role });
      return existing._id;
    }
    return await ctx.db.insert("shares", {
      pageId: args.pageId,
      ownerId: userId,
      userId: recipient._id,
      role: args.role,
      createdAt: Date.now(),
    });
  },
});

export const setRole = mutation({
  args: { pageId: v.id("pages"), userId: v.id("users"), role },
  handler: async (ctx, args) => {
    const caller = await requireUser(ctx);
    const page = await writeOwnedPage(ctx, caller, args.pageId);
    if (!page) return;
    const share = await ctx.db
      .query("shares")
      .withIndex("by_page_user", (q) =>
        q.eq("pageId", args.pageId).eq("userId", args.userId),
      )
      .unique();
    if (share) await ctx.db.patch("shares", share._id, { role: args.role });
  },
});

/** Revoke. The recipient's replica drops the subtree on its next reconcile
 *  (the pages simply vanish from their syncIndex) — no push needed. */
export const remove = mutation({
  args: { pageId: v.id("pages"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const caller = await requireUser(ctx);
    const page = await writeOwnedPage(ctx, caller, args.pageId);
    if (!page) return;
    const share = await ctx.db
      .query("shares")
      .withIndex("by_page_user", (q) =>
        q.eq("pageId", args.pageId).eq("userId", args.userId),
      )
      .unique();
    if (share) await ctx.db.delete("shares", share._id);
  },
});

/** Who this page is shared with — for the Share popover. Owner-only;
 *  foreign pages read as empty (a read must not probe existence). */
export const listForPage = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const page = await readOwnedPage(ctx, userId, args.pageId);
    if (!page) return [];
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .collect();
    const out = [];
    for (const share of shares) {
      const user = await ctx.db.get("users", share.userId);
      out.push({
        userId: share.userId,
        email: user?.email ?? "(deleted account)",
        role: share.role,
        createdAt: share.createdAt,
      });
    }
    return out;
  },
});

/** Subtree roots shared with me — for the Library's Shared tab. */
export const listSharedWithMe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const share of shares) {
      const page = await ctx.db.get("pages", share.pageId);
      if (!page || page.vault || page.inTrash) continue;
      const owner = await ctx.db.get("users", share.ownerId);
      out.push({
        pageId: page._id,
        title: page.title,
        icon: page.icon ?? null,
        type: page.type,
        role: share.role,
        ownerEmail: owner?.email ?? null,
        updatedAt: page.updatedAt,
      });
    }
    return out;
  },
});
