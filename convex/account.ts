import { v, ConvexError } from "convex/values";
import {
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
} from "@convex-dev/auth/server";
import {
  ActionCtx,
  action,
  internalMutation,
  internalQuery,
  MutationCtx,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id, TableNames } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { assertPasswordPolicy } from "./lib/passwordPolicy";
import { collectStorageKeys, storageKeyFromUrl } from "./lib/fileRefs";

/**
 * Account management, per user since Phase 1: change password, sign out of
 * every session, and delete the account (which erases that user's data —
 * or, for the sole remaining owner, factory-resets the deployment). Every
 * credentialed operation re-verifies the password with `retrieveAccount`,
 * the same scrypt check `signIn` uses, so a stolen open session can't
 * silently change or destroy an account.
 */

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get("users", userId);
    return { email: user?.email ?? null };
  },
});

/** The signed-in user's email, for actions (they have no direct db). */
export const _userEmail = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.userId);
    return user?.email ?? null;
  },
});

type AuthActionCtx = Parameters<typeof retrieveAccount>[0];

/** Throws a readable ConvexError unless `password` is this user's own. */
async function verifyOwnPassword(
  ctx: ActionCtx,
  userId: Id<"users">,
  password: string,
): Promise<string> {
  const email: string | null = await ctx.runQuery(internal.account._userEmail, {
    userId,
  });
  if (!email) {
    throw new ConvexError("This account has no email on record.");
  }
  try {
    await retrieveAccount(ctx as unknown as AuthActionCtx, {
      provider: "password",
      account: { id: email, secret: password },
    });
  } catch {
    throw new ConvexError("The current password is incorrect.");
  }
  return email;
}

export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const email = await verifyOwnPassword(ctx, userId, args.currentPassword);
    // Same policy sign-up enforces; a password change can't weaken it.
    assertPasswordPolicy(args.newPassword);
    await modifyAccountCredentials(ctx as unknown as AuthActionCtx, {
      provider: "password",
      account: { id: email, secret: args.newPassword },
    });
  },
});

/** Revoke every session (all devices). The caller signs out afterwards. */
export const signOutEverywhere = action({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    await invalidateSessions(ctx as unknown as AuthActionCtx, { userId });
  },
});

export const deleteAccount = action({
  args: { password: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await verifyOwnPassword(ctx, userId, args.password);
    await ctx.runMutation(internal.account.wipeUser, { userId });
  },
});

/**
 * Documents touched per batch. Erasing an account has to stay inside one
 * transaction's limits *whatever the workspace grew to* — a `.collect()`
 * over pages plus their versions and comments stops working somewhere past
 * a few thousand documents, and the failure mode is a user who cannot
 * delete their account at all.
 */
const WIPE_BATCH = 50;
/** Storage keys carried in scheduler args before being flushed early. */
const MAX_CARRIED_KEYS = 2000;

/** Auth records + shares: small, bounded by indexes, and what actually
 *  makes the account stop working. Done in the caller's transaction so the
 *  credentials die immediately, whatever the content erase does after. */
async function killAccount(ctx: MutationCtx, userId: Id<"users">) {
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const a of accounts) await ctx.db.delete("authAccounts", a._id);
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const s of sessions) await ctx.db.delete("authSessions", s._id);

  // Shares in both directions: grants they made (their pages are going) and
  // grants made to them (a dangling recipient otherwise). Indexed rather
  // than scanned — `by_owner` exists for exactly this.
  const asOwner = await ctx.db
    .query("shares")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();
  const asRecipient = await ctx.db
    .query("shares")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const s of [...asOwner, ...asRecipient]) {
    await ctx.db.delete("shares", s._id);
  }

  await ctx.db.delete("users", userId);
}

/**
 * Erase one user: their pages (with version/comment sidecars), uploaded
 * files, AI usage, and auth records. When the caller is the deployment
 * owner it refuses while other accounts exist — the owner deleting
 * themselves must not take the friends' workspaces down with them; once
 * they're the last account it falls through to the full factory reset
 * (which restores the original single-user re-creation flow).
 *
 * The account dies in this transaction; the content is erased by a chain of
 * scheduled batches behind it. That split is deliberate — "my account is
 * gone" must be true the moment this returns, but the content is unbounded
 * and cannot be.
 */
export const wipeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.userId);
    const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
    const isOwner =
      !!owner && (user?.email ?? "").toLowerCase().trim() === owner;

    if (isOwner) {
      const others = (await ctx.db.query("users").take(2)).filter(
        (u) => u._id !== args.userId,
      );
      if (others.length > 0) {
        throw new ConvexError(
          "Other accounts exist on this workspace. Delete them first — deleting the owner would erase the whole deployment.",
        );
      }
      await wipeEverythingImpl(ctx);
      return;
    }

    await killAccount(ctx, args.userId);
    await ctx.scheduler.runAfter(0, internal.account._wipeUserContent, {
      userId: args.userId,
      phase: "pages",
      releasing: [],
      pass: 0,
    });
  },
});

/**
 * One batch of a user's content. Each pass deletes at most WIPE_BATCH pages
 * (with their versions and comments), files, or audit rows, then schedules
 * the next — so the work is bounded per transaction and unbounded in total.
 *
 * Storage keys ride along in `releasing` and are handed to the reclaim once,
 * at the end: `files._reclaimKeys` walks the workspace to prove them
 * unreferenced, and doing that per batch would repeat the expensive part
 * dozens of times. A workspace with more keys than fit in scheduler args
 * flushes early instead.
 *
 * That early flush lets a prove chain run *while* later batches are still
 * deleting pages. Both directions of that race are safe, and both err the
 * way this module always errs — toward keeping a file. A page deleted
 * mid-scan can no longer reference anything; a page not yet deleted still
 * counts as a referrer, so its key is merely kept until tonight's sweep.
 * Neither can turn a live reference into a deletion.
 */
export const _wipeUserContent = internalMutation({
  args: {
    userId: v.id("users"),
    phase: v.union(
      v.literal("pages"),
      v.literal("files"),
      v.literal("traces"),
    ),
    releasing: v.array(v.string()),
    pass: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const releasing = new Set(args.releasing);
    let phase = args.phase;
    let more = false;

    if (phase === "pages") {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
        .take(WIPE_BATCH);
      for (const p of pages) {
        collectStorageKeys(p, releasing);
        const versions = await ctx.db
          .query("pageVersions")
          .withIndex("by_page", (q) => q.eq("pageId", p._id))
          .collect(); // bounded by MAX_VERSIONS_PER_PAGE
        for (const ver of versions) {
          collectStorageKeys(ver, releasing);
          await ctx.db.delete("pageVersions", ver._id);
        }
        const comments = await ctx.db
          .query("comments")
          .withIndex("by_page", (q) => q.eq("pageId", p._id))
          .collect();
        for (const c of comments) await ctx.db.delete("comments", c._id);
        await ctx.db.delete("pages", p._id);
      }
      more = pages.length === WIPE_BATCH;
      if (!more) phase = "files";
    } else if (phase === "files") {
      const files = await ctx.db
        .query("files")
        .withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
        .take(WIPE_BATCH);
      for (const f of files) {
        // The blobs are released by the reclaim, never deleted by owner
        // here: referencing is global, so a page someone else copied an
        // image into must not lose it when this account closes. Rows
        // written before `storageKey` existed resolve through storage.
        const key =
          f.storageKey ?? storageKeyFromUrl(await ctx.storage.getUrl(f.storageId));
        if (key) releasing.add(key);
        await ctx.db.delete("files", f._id);
      }
      more = files.length === WIPE_BATCH;
      if (!more) phase = "traces";
    } else {
      const audits = await ctx.db
        .query("webAudit")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .take(WIPE_BATCH);
      for (const a of audits) await ctx.db.delete("webAudit", a._id);
      if (audits.length === WIPE_BATCH) {
        more = true;
      } else {
        const usage = await ctx.db
          .query("aiUsage")
          .withIndex("by_user_month", (q) => q.eq("userId", args.userId))
          .take(WIPE_BATCH);
        for (const u of usage) await ctx.db.delete("aiUsage", u._id);
        more = usage.length === WIPE_BATCH;
      }
    }

    const done = !more && phase === "traces";
    const overflowing = releasing.size >= MAX_CARRIED_KEYS;
    if (done || overflowing) {
      if (releasing.size > 0) {
        await ctx.scheduler.runAfter(0, internal.files._reclaimKeys, {
          keys: [...releasing],
        });
      }
      releasing.clear();
    }
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.account._wipeUserContent, {
        userId: args.userId,
        phase,
        releasing: [...releasing],
        pass: args.pass + 1,
      });
    }
  },
});

/**
 * Factory reset, batched for the same reason as wipeUser.
 *
 * The auth tables that decide who can sign in (and whether sign-up works
 * again) are cleared synchronously; everything else drains behind it. The
 * deployment is therefore usable the moment this returns, rather than after
 * the last batch.
 */
async function wipeEverythingImpl(ctx: MutationCtx) {
  for (const table of ["authAccounts", "authSessions", "users"] as const) {
    for (const doc of await ctx.db.query(table).collect()) {
      await ctx.db.delete(table, doc._id);
    }
  }
  await ctx.scheduler.runAfter(0, internal.account._wipeEverythingBatch, {
    table: 0,
    pass: 0,
  });
}

/** Tables the factory reset drains in the background, in order. */
const RESET_TABLES: TableNames[] = [
  "pages",
  "pageVersions",
  "comments",
  "shares",
  "webAudit",
  "files",
  "aiUsage",
  "invites",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
];

export const _wipeEverythingBatch = internalMutation({
  args: { table: v.number(), pass: v.number() },
  handler: async (ctx, args): Promise<void> => {
    if (args.table >= RESET_TABLES.length) {
      // Content is gone; the blobs go last and unconditionally — this is a
      // factory reset, so there is nothing left that could reference them.
      const objects = await ctx.db.system.query("_storage").take(WIPE_BATCH);
      for (const o of objects) await ctx.storage.delete(o._id);
      if (objects.length === WIPE_BATCH) {
        await ctx.scheduler.runAfter(0, internal.account._wipeEverythingBatch, {
          table: args.table,
          pass: args.pass + 1,
        });
      }
      return;
    }
    const table = RESET_TABLES[args.table];
    const docs = await ctx.db.query(table).take(WIPE_BATCH);
    for (const doc of docs) await ctx.db.delete(table, doc._id);
    await ctx.scheduler.runAfter(0, internal.account._wipeEverythingBatch, {
      // A full batch means there may be more in this table; otherwise move on.
      table: docs.length === WIPE_BATCH ? args.table : args.table + 1,
      pass: args.pass + 1,
    });
  },
});

export const wipeEverything = internalMutation({
  args: {},
  handler: async (ctx) => {
    await wipeEverythingImpl(ctx);
  },
});
