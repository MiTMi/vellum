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
import {
  collectStorageKeys,
  isOpaqueVaultContent,
  storageKeyFromUrl,
  VAULT_UPLOADS_BLOCKED_MS,
} from "./lib/fileRefs";

/**
 * What one mark pass learned: the keys still referenced, and whether the
 * workspace holds vault ciphertext the mark phase could not read through.
 */
export interface ReferenceScan {
  keys: Set<string>;
  opaqueVault: boolean;
}

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

/** Ceiling on one storage scan, so a pathological workspace can't blow the
 *  mutation's read limit. The sweep re-runs, so progress still converges. */
const MAX_STORAGE_SCAN = 2000;

/**
 * Every storage key any surviving document still points at, in one pass.
 *
 * Scans live pages AND `pageVersions` — history snapshots hold older
 * content whose images must keep working through a restore. Deliberately
 * global rather than per-owner: if one workspace embeds another's URL,
 * deleting the first must not break the second.
 *
 * **Unbounded on purpose, and therefore CLI-only.** Two `.collect()`s over
 * whole tables blow a transaction's read limit somewhere past a couple of
 * thousand documents, so the reclaim paths do NOT use this — they walk the
 * same two tables in scheduled batches (`_prove` below). It survives for
 * `admin:storageReport`, which is an owner CLI query run by hand on a
 * workspace whose size the owner already knows.
 */
export async function scanReferences(ctx: QueryCtx): Promise<ReferenceScan> {
  const keys = new Set<string>();
  let opaqueVault = false;
  for (const page of await ctx.db.query("pages").collect()) {
    // The whole document, not just `content`: covers, database row `props`,
    // bookmark/embed block props and anything a future block type adds.
    collectStorageKeys(page, keys);
    if (isOpaqueVaultContent(page)) opaqueVault = true;
  }
  for (const version of await ctx.db.query("pageVersions").collect()) {
    collectStorageKeys(version, keys);
    if (isOpaqueVaultContent(version)) opaqueVault = true;
  }
  return { keys, opaqueVault };
}

/** The "mark" half on its own, for callers that don't delete anything. */
export async function referencedKeys(ctx: QueryCtx): Promise<Set<string>> {
  return (await scanReferences(ctx)).keys;
}

/**
 * True when this scan cannot prove `key` unreferenced, because the
 * workspace holds vault ciphertext old enough to have swallowed a
 * reference to it.
 *
 * The mark phase reads plaintext. A storage URL sealed inside a vault
 * page's `{__venc, iv, data}` envelope is base64 — `collectStorageKeys`
 * sees no `/api/storage/` and reports nothing, so "not in the set" stops
 * meaning "not referenced" and the sweep would delete a live image. That
 * inverts this module's one rule: every ambiguity resolves toward keeping
 * a file.
 *
 * The exposure is bounded and closed at both ends. Uploads inside the
 * vault have been refused since 2026-08-12 (`uploadForPage` throws,
 * CoverPicker passes `allowUpload={false}`), so no blob created after that
 * can be hidden in ciphertext; and if there is no encrypted vault content
 * at all, nothing is hidden. Only the overlap is protected, and it never
 * grows. Lifting the vault upload ban means encrypting file bytes
 * client-side, at which point this needs revisiting rather than deleting.
 */
function opaqueToScan(opaqueVault: boolean, createdAt: number): boolean {
  return opaqueVault && createdAt < VAULT_UPLOADS_BLOCKED_MS;
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
 * ## Why reclamation is a chain of scheduled batches
 *
 * Proving a key unreferenced means reading every page and every version —
 * a reference can be anywhere, which is the whole point of the
 * field-agnostic walker in `lib/fileRefs.ts`. Doing that in one
 * transaction (two `.collect()`s) works for a small workspace and then
 * stops working: past a few thousand documents it exceeds a mutation's
 * read limit and throws. Deleting a page would still succeed — the
 * reclaim is scheduled separately — but the bytes would never be freed
 * again, silently.
 *
 * So the scan is split across scheduled passes carrying their state in
 * arguments: a candidate list that only ever shrinks, the table and cursor
 * reached so far, and whether unreadable vault content has been seen. The
 * decisive property is preserved exactly: **nothing is destroyed until
 * both tables have been walked to the end**, so a delete is never made on
 * partial information. A pass that finds every candidate referenced stops
 * the chain early.
 *
 * Accepted cost, stated rather than engineered around: the single
 * transaction was serializable, and a chain is not. For the seconds the
 * chain runs there is a window where someone could paste a candidate's raw
 * `/api/storage/…` URL into a page that has already been scanned, and the
 * final pass would delete a now-live reference. That requires pasting the
 * raw URL of a file deleted moments earlier; not worth a locking scheme.
 */

/** Documents read per pass. Bounded by BYTES, not count — page content can
 *  be hundreds of KB, so the 8 MiB read limit binds long before any
 *  document ceiling would. */
const SCAN_BATCH = 50;
/** Blobs destroyed per pass, and the bound on the whole chain. */
const MAX_DELETES_PER_PASS = 200;
const MAX_CHAIN_PASSES = 200;

/**
 * Reclaim specific storage keys released by a deletion.
 *
 * Scheduled by `pages.deleteForever` / `pages.emptyTrash` /
 * `account.wipeUser`. A key survives if ANY remaining page or version
 * still references it — which is what makes this safe for duplicated
 * pages, where two docs share one blob.
 *
 * Needs no grace period, unlike `_sweep`: the candidates come from content
 * that was just deleted, never from scanning storage, so an upload still
 * in flight for another page cannot be caught by it.
 */
export const _reclaimKeys = internalMutation({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ candidates: number }> => {
    const candidates = [...new Set(args.keys)];
    if (candidates.length === 0) return { candidates: 0 };
    await ctx.scheduler.runAfter(0, internal.files._prove, {
      candidates,
      phase: "pages",
      cursor: null,
      opaqueVault: false,
      pass: 0,
    });
    return { candidates: candidates.length };
  },
});

/**
 * One batch of the mark phase: narrow the candidate list against a slice of
 * `pages`, then of `pageVersions`, then destroy whatever is left.
 *
 * `.paginate()` rather than a hand-rolled `_creationTime` cursor: several
 * documents can share a creation timestamp (trivially so under the test
 * suite's frozen clock), and a strict-greater-than cursor would skip the
 * ties — silently leaving pages unscanned, which is precisely how a live
 * file gets deleted.
 */
export const _prove = internalMutation({
  args: {
    candidates: v.array(v.string()),
    phase: v.union(v.literal("pages"), v.literal("versions")),
    cursor: v.union(v.string(), v.null()),
    opaqueVault: v.boolean(),
    dryRun: v.optional(v.boolean()),
    /** Set by `_sweep` when its storage scan filled up, so another sweep
     *  is started once this chain has finished clearing the backlog. */
    resweepGraceMs: v.optional(v.number()),
    resweep: v.optional(v.boolean()),
    pass: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    if (args.candidates.length === 0) return;
    if (args.pass >= MAX_CHAIN_PASSES) {
      // Out of budget with the scan incomplete: keeping the files is the
      // only safe end, and the daily cron will try again.
      console.warn(
        `files._prove hit ${MAX_CHAIN_PASSES} passes with the scan incomplete — nothing deleted.`,
      );
      return;
    }

    const remaining = new Set(args.candidates);
    let opaqueVault = args.opaqueVault;
    const found = new Set<string>();

    const batch =
      args.phase === "pages"
        ? await ctx.db
            .query("pages")
            .paginate({ numItems: SCAN_BATCH, cursor: args.cursor })
        : await ctx.db
            .query("pageVersions")
            .paginate({ numItems: SCAN_BATCH, cursor: args.cursor });

    for (const doc of batch.page) {
      // The whole document, not just `content`: covers, database row
      // `props`, bookmark/embed props and anything a future block adds.
      collectStorageKeys(doc, found);
      if (isOpaqueVaultContent(doc)) opaqueVault = true;
    }
    for (const key of found) remaining.delete(key);

    // Every candidate turned out to be referenced — nothing to delete, and
    // no reason to read the rest of the workspace.
    if (remaining.size === 0) return;

    const next = { ...args, candidates: [...remaining], opaqueVault, pass: args.pass + 1 };
    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.files._prove, {
        ...next,
        cursor: batch.continueCursor,
      });
      return;
    }
    if (args.phase === "pages") {
      await ctx.scheduler.runAfter(0, internal.files._prove, {
        ...next,
        phase: "versions",
        cursor: null,
      });
      return;
    }

    // Both tables walked to the end: these keys are genuinely unreferenced.
    await ctx.scheduler.runAfter(0, internal.files._destroy, {
      keys: [...remaining],
      opaqueVault,
      dryRun: args.dryRun,
      resweep: args.resweep,
      resweepGraceMs: args.resweepGraceMs,
      pass: args.pass + 1,
    });
  },
});

/**
 * The sweep half: destroy keys a completed scan proved unreferenced.
 *
 * Capped per pass and continued, so a large backlog clears in minutes
 * rather than one nightly cron per 200 files. Re-proving is deliberately
 * NOT repeated for the continuation — the chain already proved this exact
 * set, and re-reading both tables per 200 deletions is what this whole
 * restructure exists to avoid.
 */
export const _destroy = internalMutation({
  args: {
    keys: v.array(v.string()),
    opaqueVault: v.boolean(),
    dryRun: v.optional(v.boolean()),
    resweep: v.optional(v.boolean()),
    resweepGraceMs: v.optional(v.number()),
    pass: v.number(),
  },
  handler: async (ctx, args): Promise<{ deleted: number; bytes: number }> => {
    let deleted = 0;
    let bytes = 0;
    /** Ran out of per-pass budget — must be carried to a continuation, or
     *  the tail of a backlog is silently abandoned. */
    const leftover: string[] = [];
    /** Uploads predating the `files` table resolve only through storage,
     *  which is scanned once and only if still needed. */
    const unresolved: string[] = [];

    for (const key of args.keys) {
      if (deleted >= MAX_DELETES_PER_PASS) {
        leftover.push(key);
        continue;
      }
      const rows = await ctx.db
        .query("files")
        .withIndex("by_key", (q) => q.eq("storageKey", key))
        .collect();
      if (rows.length === 0) {
        unresolved.push(key);
        continue;
      }
      // Old enough to be referenced from inside vault ciphertext the scan
      // can't read — "not in the set" doesn't prove unreferenced here. A
      // final decision, so it never returns as leftover.
      if (opaqueToScan(args.opaqueVault, rows[0].createdAt)) continue;
      bytes += rows.reduce((n, r) => n + r.size, 0);
      if (!args.dryRun) {
        await destroy(
          ctx,
          rows[0].storageId,
          rows.map((r) => r._id),
        );
      }
      deleted++;
    }

    if (unresolved.length > 0) {
      if (deleted >= MAX_DELETES_PER_PASS) {
        // No budget left to even look them up.
        leftover.push(...unresolved);
      } else {
        const wanted = new Set(unresolved);
        const objects = await ctx.db.system
          .query("_storage")
          .take(MAX_STORAGE_SCAN);
        for (const object of objects) {
          const key = storageKeyFromUrl(await ctx.storage.getUrl(object._id));
          if (!key || !wanted.has(key)) continue;
          if (deleted >= MAX_DELETES_PER_PASS) {
            leftover.push(key);
            continue;
          }
          if (opaqueToScan(args.opaqueVault, object._creationTime)) continue;
          bytes += object.size ?? 0;
          if (!args.dryRun) await destroy(ctx, object._id, []);
          deleted++;
        }
        // Anything in `unresolved` that matched no storage object has no
        // blob to delete — a finished decision, not a leftover.
      }
    }

    if (args.dryRun) {
      console.log(
        `files: dry run — would remove ${deleted} blob(s), ${Math.round(bytes / 1024)} KB.`,
      );
    }

    // A dry run never continues: it deletes nothing, so the next pass would
    // see the identical set and recurse forever.
    if (leftover.length > 0 && !args.dryRun && args.pass < MAX_CHAIN_PASSES) {
      await ctx.scheduler.runAfter(0, internal.files._destroy, {
        ...args,
        keys: leftover,
        pass: args.pass + 1,
      });
    } else if (args.resweep && !args.dryRun) {
      // The storage scan that produced these candidates filled its cap, so
      // there is more to look at than one sweep could see.
      await ctx.scheduler.runAfter(0, internal.files._sweep, {
        graceMs: args.resweepGraceMs,
      });
    }
    return { deleted, bytes };
  },
});

/**
 * Global mark-and-sweep: the safety net for what the targeted path
 * structurally cannot see — uploads abandoned before their block was ever
 * saved, blobs predating the `files` table, and references freed when a
 * snapshot ages out past MAX_VERSIONS_PER_PAGE.
 *
 * This half only *nominates* candidates: every blob older than the grace
 * period. Proving them unreferenced and destroying them is the shared
 * `_prove` → `_destroy` chain, so a sweep reads only storage and never
 * walks a whole workspace in one transaction.
 *
 * `graceMs` is overridable only so tests can exercise the delete path
 * without waiting a day — internal, so no client can reach it. `dryRun`
 * runs the whole chain and destroys nothing, reporting to the log.
 */
export const _sweep = internalMutation({
  args: {
    graceMs: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; candidates: number }> => {
    const grace = args.graceMs ?? SWEEP_GRACE_MS;
    const cutoff = Date.now() - grace;

    const objects = await ctx.db.system.query("_storage").take(MAX_STORAGE_SCAN);
    const candidates = new Set<string>();
    for (const object of objects) {
      if (object._creationTime >= cutoff) continue; // still in its grace window
      const key = storageKeyFromUrl(await ctx.storage.getUrl(object._id));
      // A blob whose URL we can't resolve is never nominated — unknown
      // means keep, always.
      if (key) candidates.add(key);
    }
    if (candidates.size === 0) return { scanned: objects.length, candidates: 0 };

    await ctx.scheduler.runAfter(0, internal.files._prove, {
      candidates: [...candidates],
      phase: "pages",
      cursor: null,
      opaqueVault: false,
      dryRun: args.dryRun,
      // More blobs than one scan could see: go round again once this chain
      // has finished, rather than waiting for tomorrow's cron.
      resweep: objects.length >= MAX_STORAGE_SCAN,
      resweepGraceMs: args.graceMs,
      pass: 0,
    });
    return { scanned: objects.length, candidates: candidates.size };
  },
});
