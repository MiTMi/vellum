import {
  internalMutation,
  mutation,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isOwnerUser, requireUser } from "./lib/auth";
import { FILE_QUOTA_BYTES, fileBytesOf } from "./lib/quotas";
import { collectStorageKeys, storageKeyFromUrl } from "./lib/fileRefs";

/**
 * File uploads and their reclamation.
 *
 * Uploads carry the 50 MB per-user quota (docs/multi-user-plan.md); the
 * owner (OWNER_EMAIL) is exempt. Enforcement happens at registration
 * (`getFileUrl`, the step every upload flow already calls right after the
 * POST): the size is only knowable then, and an over-quota file is deleted
 * from storage before the error is returned, so it can't linger unbilled.
 *
 * ## Reclamation (audit finding, 2026-08-12)
 *
 * Until now nothing ever deleted a stored blob when its page went away —
 * `deleteForever`/`emptyTrash` dropped rows and sidecars, and the bytes
 * stayed forever, invisible to the quota. Two such orphans were found on
 * production. Mark-and-sweep fixes it, in two complementary halves:
 *
 *  - **`_reclaimKeys` — targeted and immediate.** A page deletion knows
 *    exactly which storage keys it released, so it schedules a reclaim of
 *    just those. Safe with no grace period *because the key set comes from
 *    deleted content, never from scanning storage*: an upload still in
 *    flight for some other page was never in the set, so it cannot be
 *    caught. This is what makes "delete the page" mean "delete the bytes"
 *    within seconds.
 *
 *  - **`_sweep` — global and grace-guarded.** A daily cron catching what
 *    the targeted path structurally cannot see: uploads abandoned before
 *    their block was ever saved, and blobs predating the `files` table.
 *    Here a grace period IS required, since a brand-new upload legitimately
 *    has no referrer yet.
 *
 * Both share `referencedKeys`, and both err toward keeping a file: a missed
 * orphan costs bytes until tomorrow, a wrong delete destroys a user's image.
 */

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

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
    // A storageId registered to SOMEONE ELSE is not the caller's retry —
    // refuse without serving a URL (audit finding, 2026-08-12). Same
    // {url, error} shape, and crucially no throw and no delete: a throw
    // would roll back sibling work, and the file is the other user's.
    if (already && already.ownerId !== userId) {
      return { url: null, error: "That file belongs to another account." };
    }

    const url = await ctx.storage.getUrl(args.storageId);

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
        // Recorded now so reclamation is an index lookup rather than a
        // scan that has to re-derive every file's URL.
        storageKey: storageKeyFromUrl(url) ?? undefined,
      });
    } else if (already.storageKey === undefined) {
      // Backfill a row written before the column existed.
      const key = storageKeyFromUrl(url);
      if (key) await ctx.db.patch("files", already._id, { storageKey: key });
    }

    return { url };
  },
});

/* ------------------------------------------------------------------ */
/* Reclamation                                                         */
/* ------------------------------------------------------------------ */

/**
 * How long a never-referenced blob is protected from the global sweep.
 *
 * An upload lands in storage *before* the block embedding it is saved, so
 * a freshly uploaded file legitimately has no referrer for a moment. A day
 * is far beyond that window (uploads require a live connection, and the
 * editor's save debounce is sub-second) and costs nothing but a day of
 * bytes in the rare abandoned-upload case.
 *
 * This does NOT delay ordinary deletion: `_reclaimKeys` runs immediately
 * and ignores the grace period entirely, because it only ever considers
 * keys that a just-deleted page actually referenced.
 */
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Ceiling on one sweep pass, so a pathological workspace can't blow the
 *  mutation's read limit. The cron re-runs, so progress still converges. */
const MAX_STORAGE_SCAN = 2000;
const MAX_DELETES_PER_PASS = 200;

/**
 * Every storage key any surviving document still points at.
 *
 * Scans live pages AND `pageVersions` — history snapshots hold older
 * content whose images must keep working through a restore. Deliberately
 * global rather than per-owner: if one workspace embeds another's URL,
 * deleting the first must not break the second. Correctness over speed,
 * and the page quota bounds the work.
 */
export async function referencedKeys(ctx: QueryCtx): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const page of await ctx.db.query("pages").collect()) {
    // The whole document, not just `content`: covers, database row `props`,
    // bookmark/embed block props and anything a future block type adds.
    collectStorageKeys(page, keys);
  }
  for (const version of await ctx.db.query("pageVersions").collect()) {
    collectStorageKeys(version, keys);
  }
  return keys;
}

/** Drop a blob and its bookkeeping row together. */
async function destroy(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  fileRowIds: Id<"files">[],
): Promise<void> {
  // Storage first: if it throws we haven't yet lost the row that tells us
  // the blob exists, so the next sweep retries instead of leaking silently.
  await ctx.storage.delete(storageId);
  for (const id of fileRowIds) await ctx.db.delete("files", id);
}

/**
 * Reclaim specific storage keys released by a deletion.
 *
 * Scheduled by `pages.deleteForever` / `pages.emptyTrash`. A key survives
 * if ANY remaining page or version still references it — which is what
 * makes this safe for duplicated pages, where two docs share one blob.
 */
export const _reclaimKeys = internalMutation({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    const candidates = [...new Set(args.keys)];
    if (candidates.length === 0) return { deleted: 0 };

    const referenced = await referencedKeys(ctx);
    const orphaned = candidates.filter((k) => !referenced.has(k));
    if (orphaned.length === 0) return { deleted: 0 };

    let deleted = 0;
    // Registered files resolve through the index; anything left over
    // (uploads predating the `files` table) needs storage itself, which is
    // scanned once and only if still needed.
    const unresolved: string[] = [];
    for (const key of orphaned) {
      const rows = await ctx.db
        .query("files")
        .withIndex("by_key", (q) => q.eq("storageKey", key))
        .collect();
      if (rows.length === 0) {
        unresolved.push(key);
        continue;
      }
      await destroy(
        ctx,
        rows[0].storageId,
        rows.map((r) => r._id),
      );
      deleted++;
    }

    if (unresolved.length > 0) {
      const wanted = new Set(unresolved);
      const objects = await ctx.db.system
        .query("_storage")
        .take(MAX_STORAGE_SCAN);
      for (const object of objects) {
        const key = storageKeyFromUrl(await ctx.storage.getUrl(object._id));
        if (!key || !wanted.has(key)) continue;
        await destroy(ctx, object._id, []);
        deleted++;
      }
    }

    return { deleted };
  },
});

/**
 * Global mark-and-sweep: delete every stored blob no document references.
 *
 * The safety net, run daily by cron and invocable by the owner. `graceMs`
 * is overridable only so tests can exercise the delete path without
 * waiting a day — it is internal, so no client can reach it.
 *
 * A pass is capped (MAX_DELETES_PER_PASS) to stay inside one mutation's
 * limits, so it **continues itself** when it fills that cap rather than
 * waiting for tomorrow's cron: a backlog of thousands must not take
 * thousands of days to clear. Progress is guaranteed because every pass
 * removes rows from `_storage`, and `pass` bounds the chain regardless.
 * A dry run never continues — nothing is deleted, so the next pass would
 * see the identical set and recurse forever.
 */
const MAX_SWEEP_PASSES = 25;

export const _sweep = internalMutation({
  args: {
    graceMs: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    pass: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scanned: number;
    deleted: number;
    bytes: number;
    done: boolean;
    continued: boolean;
  }> => {
    const grace = args.graceMs ?? SWEEP_GRACE_MS;
    const cutoff = Date.now() - grace;
    const referenced = await referencedKeys(ctx);

    const objects = await ctx.db.system.query("_storage").take(MAX_STORAGE_SCAN);
    let deleted = 0;
    let bytes = 0;

    for (const object of objects) {
      if (deleted >= MAX_DELETES_PER_PASS) break;
      if (object._creationTime >= cutoff) continue; // still in its grace window
      const key = storageKeyFromUrl(await ctx.storage.getUrl(object._id));
      // A blob whose URL we can't resolve is never deleted — unknown means
      // keep, always.
      if (!key || referenced.has(key)) continue;

      const rows = await ctx.db
        .query("files")
        .withIndex("by_key", (q) => q.eq("storageKey", key))
        .collect();
      // Rows written before `storageKey` existed won't match by key; find
      // them by storageId so their bookkeeping dies with the blob.
      const byId = await ctx.db
        .query("files")
        .withIndex("by_storageId", (q) => q.eq("storageId", object._id))
        .collect();
      const rowIds = [...new Set([...rows, ...byId].map((r) => r._id))];

      bytes += object.size ?? 0;
      if (!args.dryRun) await destroy(ctx, object._id, rowIds);
      deleted++;
    }

    const pass = args.pass ?? 0;
    const done = deleted < MAX_DELETES_PER_PASS;
    const continued = !done && !args.dryRun && pass + 1 < MAX_SWEEP_PASSES;
    if (continued) {
      await ctx.scheduler.runAfter(0, internal.files._sweep, {
        graceMs: args.graceMs,
        pass: pass + 1,
      });
    } else if (!done && !args.dryRun) {
      // Hit the chain bound with work still outstanding: the cron picks it
      // up tomorrow, but say so rather than reporting a clean finish.
      console.warn(
        `files._sweep stopped after ${MAX_SWEEP_PASSES} passes with deletions still pending.`,
      );
    }

    return { scanned: objects.length, deleted, bytes, done, continued };
  },
});
