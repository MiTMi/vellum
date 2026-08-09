import { Auth } from "convex/server";
import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/**
 * Multi-tenant access control (Phase 1, docs/multi-user-plan.md).
 *
 * Every public function starts with `requireUser`; anything touching a page
 * then goes through `readOwnedPage` / `writeOwnedPage` — the single choke
 * point that decides whether the signed-in user may see or change a row.
 *
 * Parent-ownership invariant: create/createWithDoc/move/duplicate all
 * reject foreign parents, so a page's children always share its ownerId.
 * That is what makes the `by_parent` subtree walks in pages.ts safe without
 * per-row checks — the entry point is owned, therefore the subtree is.
 */

export async function requireUser(ctx: { auth: Auth }): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Not authenticated");
  }
  return userId;
}

/**
 * Is this user the deployment owner (OWNER_EMAIL)? The owner is exempt from
 * quotas and may run admin functions; since Phase 1 the env var no longer
 * gates sign-in. Unknown/malformed user ids (e.g. a stale CLI identity)
 * are simply not the owner — fail closed.
 */
export async function isOwnerUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
  if (!owner) return false;
  try {
    const user = await ctx.db.get("users", userId);
    return (user?.email ?? "").toLowerCase().trim() === owner;
  } catch {
    return false;
  }
}

/**
 * Read access: the page, or null when it doesn't exist *or* belongs to
 * someone else — indistinguishable on purpose, so reads can't be used to
 * probe which ids exist.
 */
export async function readOwnedPage(
  ctx: QueryCtx,
  userId: Id<"users">,
  id: Id<"pages">,
): Promise<Doc<"pages"> | null> {
  let page: Doc<"pages"> | null;
  try {
    page = await ctx.db.get("pages", id);
  } catch {
    return null;
  }
  if (!page || page.ownerId !== userId) return null;
  return page;
}

/**
 * Write access: null when the page is gone (replayed offline ops race
 * deletes — callers no-op), but a LOUD throw for someone else's page, so
 * isolation violations surface in tests and a malicious replay is dropped
 * deterministically by the outbox instead of retrying forever.
 */
export async function writeOwnedPage(
  ctx: QueryCtx,
  userId: Id<"users">,
  id: Id<"pages">,
): Promise<Doc<"pages"> | null> {
  let page: Doc<"pages"> | null;
  try {
    page = await ctx.db.get("pages", id);
  } catch {
    return null;
  }
  if (!page) return null;
  if (page.ownerId !== userId) {
    throw new ConvexError("Not authorized");
  }
  return page;
}

/** Every page belonging to this user (trashed included). */
export async function pagesOf(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"pages">[]> {
  return await ctx.db
    .query("pages")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();
}
