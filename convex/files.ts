import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

/** Step 1 of an upload: the client asks for a short-lived upload URL. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Step 2: after POSTing the file, exchange the storageId for a serving URL. */
export const getFileUrl = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.storage.getUrl(args.storageId);
  },
});
