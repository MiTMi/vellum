import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { monthKey } from "./lib/quotas";
import { referencedKeys } from "./files";
import { storageKeyFromUrl } from "./lib/fileRefs";

/**
 * Owner tooling, CLI-only (internal functions are unreachable from
 * clients; `npx convex run` uses the deployment admin key):
 *
 *   npx convex run admin:mintInvite '{"note":"for Dana"}' --prod
 *   npx convex run admin:listInvites '{}' --prod
 *   npx convex run admin:usageOverview '{}' --prod
 *   npx convex run admin:backfillOwnerBatch '{}' --prod   # repeat until done
 *   npx convex run admin:migrationGate '{}' --prod
 */

function newInviteCode(): string {
  // 10 base-36 chars ≈ 51 bits: unguessable enough for a code that is also
  // single-use and human-typeable. CSPRNG (audit finding, 2026-08-12) —
  // the code gates account creation on the deployment.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % 36]).join("");
}

/** The owner's real userId — CLI impersonation needs it in the subject
 *  (`--identity '{"subject":"<userId>|cli"}'`) now that functions compare
 *  real ids. Used by scripts/e2e-offline.mjs and ad-hoc CLI work. */
/** Recent outgoing web ops (agent webSearch/fetchUrl), newest first —
 *  the misuse audit trail. Internal: owner CLI only.
 *  npx convex run admin:webAuditRecent '{"limit":50}' --prod          */
export const webAuditRecent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("webAudit")
      .withIndex("by_at")
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    const emails = new Map<string, string>();
    const out = [];
    for (const row of rows) {
      if (!emails.has(row.userId)) {
        const user = await ctx.db.get("users", row.userId);
        emails.set(row.userId, user?.email ?? "(deleted account)");
      }
      out.push({
        at: new Date(row.at).toISOString(),
        user: emails.get(row.userId)!,
        kind: row.kind,
        text: row.text,
        allowed: row.allowed,
        reason: row.reason ?? null,
      });
    }
    return out;
  },
});

export const ownerUserId = internalQuery({
  args: {},
  handler: async (ctx) => {
    const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
    if (!owner) throw new ConvexError("OWNER_EMAIL is not configured.");
    const users = await ctx.db.query("users").collect();
    const user = users.find(
      (u) => (u.email ?? "").toLowerCase().trim() === owner,
    );
    if (!user) throw new ConvexError("No user matches OWNER_EMAIL.");
    return user._id;
  },
});

/**
 * Every stored blob, and whether anything still points at it — the answer
 * to "is it really deleted?", which used to be unanswerable.
 *
 * `usageOverview`'s fileMB reads the `files` table, so it reports zero for
 * blobs uploaded before that table existed; this reads `_storage` itself,
 * which is the ground truth. Anything listed as unreferenced will be
 * removed by the next nightly sweep, or immediately by
 *   npx convex run files:_sweep '{}' --prod
 *
 *   npx convex run admin:storageReport '{}' --prod
 */
export const storageReport = internalQuery({
  args: {},
  handler: async (ctx) => {
    const referenced = await referencedKeys(ctx);
    const objects = await ctx.db.system.query("_storage").take(2000);
    const rows = [];
    let orphanBytes = 0;
    for (const object of objects) {
      const key = storageKeyFromUrl(await ctx.storage.getUrl(object._id));
      const inUse = !!key && referenced.has(key);
      if (!inUse) orphanBytes += object.size ?? 0;
      const owner = await ctx.db
        .query("files")
        .withIndex("by_storageId", (q) => q.eq("storageId", object._id))
        .unique();
      rows.push({
        storageId: object._id,
        uploaded: new Date(object._creationTime).toISOString(),
        contentType: object.contentType ?? null,
        kb: Math.round((object.size ?? 0) / 1024),
        referenced: inUse,
        registered: !!owner,
      });
    }
    return {
      totalObjects: objects.length,
      unreferenced: rows.filter((r) => !r.referenced).length,
      unreferencedKB: Math.round(orphanBytes / 1024),
      objects: rows,
    };
  },
});

export const mintInvite = internalMutation({
  args: { note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const code = newInviteCode();
    await ctx.db.insert("invites", {
      code,
      note: args.note,
      createdAt: Date.now(),
    });
    return code;
  },
});

export const listInvites = internalQuery({
  args: {},
  handler: async (ctx) => {
    const invites = await ctx.db.query("invites").collect();
    return invites.map((i) => ({
      code: i.code,
      note: i.note ?? null,
      redeemed: !!i.redeemedBy,
      redeemedAt: i.redeemedAt ?? null,
    }));
  },
});

/** Per-user totals: pages, stored file MB, and this month's AI spend. */
export const usageOverview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const month = monthKey();
    const out = [];
    for (const u of users) {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_owner", (q) => q.eq("ownerId", u._id))
        .collect();
      const files = await ctx.db
        .query("files")
        .withIndex("by_owner", (q) => q.eq("ownerId", u._id))
        .collect();
      const ai = await ctx.db
        .query("aiUsage")
        .withIndex("by_user_month", (q) => q.eq("userId", u._id).eq("month", month))
        .unique();
      out.push({
        email: u.email ?? "(no email)",
        userId: u._id,
        pages: pages.length,
        fileMB:
          Math.round((files.reduce((n, f) => n + f.size, 0) / 1024 / 1024) * 10) /
          10,
        aiUsdThisMonth: (ai?.costMicroUsd ?? 0) / 1_000_000,
        aiCallsThisMonth: ai?.calls ?? 0,
      });
    }
    return out;
  },
});

const BACKFILL_BATCH = 200;

/**
 * Migration step: stamp every ownerless row with the owner's userId.
 * Batched; run repeatedly until it reports `{ done: true }`. Safe to
 * re-run — it only ever touches rows with no ownerId (which is also why
 * re-running it after the scoped-functions deploy closes the window for
 * rows created in between).
 */
export const backfillOwnerBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
    if (!owner) throw new ConvexError("OWNER_EMAIL is not configured.");
    const users = await ctx.db.query("users").collect();
    const ownerUser = users.find(
      (u) => (u.email ?? "").toLowerCase().trim() === owner,
    );
    if (!ownerUser) throw new ConvexError("No user matches OWNER_EMAIL.");

    let stamped = 0;
    for (const table of ["pages", "pageVersions", "comments"] as const) {
      if (stamped >= BACKFILL_BATCH) break;
      const rows = await ctx.db
        .query(table)
        .withIndex("by_owner", (q) => q.eq("ownerId", undefined))
        .take(BACKFILL_BATCH - stamped);
      for (const row of rows) {
        await ctx.db.patch(table, row._id, { ownerId: ownerUser._id });
        stamped++;
      }
    }
    return { stamped, done: stamped === 0, ownerUserId: ownerUser._id };
  },
});

/** Post-migration gate: no invites go out until every count reads zero. */
export const migrationGate = internalQuery({
  args: {},
  handler: async (ctx) => {
    const unowned = async (table: "pages" | "pageVersions" | "comments") =>
      (
        await ctx.db
          .query(table)
          .withIndex("by_owner", (q) => q.eq("ownerId", undefined))
          .collect()
      ).length;
    return {
      unownedPages: await unowned("pages"),
      unownedVersions: await unowned("pageVersions"),
      unownedComments: await unowned("comments"),
    };
  },
});
