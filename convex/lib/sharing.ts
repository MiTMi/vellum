import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

export type ShareRole = "viewer" | "editor";

/**
 * Every page shared with this user: each `shares.by_user` root plus its
 * subtree (`by_parent` BFS — safe without per-row checks because the
 * parent-ownership invariant makes a subtree single-owner). Overlapping
 * shares resolve to the highest role, matching `getAccessiblePage`'s
 * ancestor walk. Vault pages are excluded defensively at every level —
 * they can't be shared, but a guarantee this load-bearing shouldn't rest
 * on one write-path check.
 */
export async function sharedPagesFor(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Map<Id<"pages">, { page: Doc<"pages">; role: ShareRole }>> {
  const out = new Map<Id<"pages">, { page: Doc<"pages">; role: ShareRole }>();
  const shares = await ctx.db
    .query("shares")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const share of shares) {
    const root = await ctx.db.get("pages", share.pageId);
    if (!root || root.vault) continue;
    const queue: Doc<"pages">[] = [root];
    while (queue.length > 0) {
      const page = queue.shift()!;
      if (page.vault) continue;
      const seen = out.get(page._id);
      if (!seen || (seen.role === "viewer" && share.role === "editor")) {
        out.set(page._id, { page, role: share.role });
      } else if (seen) {
        // Already covered by an equal-or-better share — its subtree too.
        continue;
      }
      const children = await ctx.db
        .query("pages")
        .withIndex("by_parent", (q) => q.eq("parentId", page._id))
        .collect();
      queue.push(...children);
    }
  }
  return out;
}
