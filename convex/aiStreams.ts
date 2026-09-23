import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

/**
 * Live progress of one agent request (see `streamWriter` in ai.ts). The
 * stream id is minted by the client and is not a secret on its own — every
 * read and write is also bound to the signed-in owner, so another account
 * holding the id sees null and cannot overwrite the row.
 */
export const get = query({
  args: { streamId: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db
      .query("aiStreams")
      .withIndex("by_stream", (q) => q.eq("streamId", args.streamId))
      .first();
    if (!row || row.ownerId !== userId) return null;
    return { status: row.status ?? null, text: row.text };
  },
});

export const _write = internalMutation({
  args: {
    userId: v.id("users"),
    streamId: v.string(),
    status: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("aiStreams")
      .withIndex("by_stream", (q) => q.eq("streamId", args.streamId))
      .first();
    const fields = {
      status: args.status,
      text: args.text,
      updatedAt: Date.now(),
    };
    if (!row) {
      await ctx.db.insert("aiStreams", {
        ownerId: args.userId,
        streamId: args.streamId,
        ...fields,
      });
    } else if (row.ownerId === args.userId) {
      await ctx.db.patch("aiStreams", row._id, fields);
    }
    // Someone else's row under the same id: leave it alone.
  },
});

export const _clear = internalMutation({
  args: { userId: v.id("users"), streamId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("aiStreams")
      .withIndex("by_stream", (q) => q.eq("streamId", args.streamId))
      .collect();
    for (const r of rows) {
      if (r.ownerId === args.userId) await ctx.db.delete("aiStreams", r._id);
    }
  },
});
