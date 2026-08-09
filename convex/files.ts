import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { isOwnerUser, requireUser } from "./lib/auth";
import { FILE_QUOTA_BYTES, fileBytesOf } from "./lib/quotas";

/**
 * File uploads, with the 50 MB per-user quota (docs/multi-user-plan.md).
 * The owner (OWNER_EMAIL) is exempt. Enforcement happens at registration
 * (`getFileUrl`, the step every upload flow already calls right after the
 * POST): the size is only knowable then, and an over-quota file is deleted
 * from storage before the error is thrown, so it can't linger unbilled.
 */

/** Step 1 of an upload: the client asks for a short-lived upload URL. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    // Cheap early refusal for users already at their cap — the real
    // enforcement is in getFileUrl, where the byte count is known.
    if (!(await isOwnerUser(ctx, userId))) {
      const used = await fileBytesOf(ctx, userId);
      if (used >= FILE_QUOTA_BYTES) {
        throw new ConvexError(
          `Storage is full (${Math.round(used / 1024 / 1024)} MB of ${Math.round(FILE_QUOTA_BYTES / 1024 / 1024)} MB used).`,
        );
      }
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Step 2: after POSTing the file, exchange the storageId for a serving URL.
 *
 * The quota refusal is a *return value*, not a throw: a throwing mutation
 * rolls back its whole transaction, which would resurrect the very
 * `storage.delete` that reclaims the refused file.
 */
export const getFileUrl = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string | null; error?: string }> => {
    const userId = await requireUser(ctx);

    // Register the upload against its owner exactly once (retries are
    // idempotent via by_storageId).
    const already = await ctx.db
      .query("files")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (!already) {
      const meta = await ctx.db.system.get("_storage", args.storageId);
      const size = meta?.size ?? 0;
      if (!(await isOwnerUser(ctx, userId))) {
        const used = await fileBytesOf(ctx, userId);
        if (used + size > FILE_QUOTA_BYTES) {
          // Don't keep what we won't serve.
          await ctx.storage.delete(args.storageId);
          return {
            url: null,
            error: `That file doesn't fit in your storage (${Math.round(used / 1024 / 1024)} MB of ${Math.round(FILE_QUOTA_BYTES / 1024 / 1024)} MB used).`,
          };
        }
      }
      await ctx.db.insert("files", {
        storageId: args.storageId,
        ownerId: userId,
        size,
        createdAt: Date.now(),
      });
    }

    return { url: await ctx.storage.getUrl(args.storageId) };
  },
});
