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
 * Erase one user: their pages (with version/comment sidecars), uploaded
 * files, AI usage, and auth records. When the caller is the deployment
 * owner it refuses while other accounts exist — the owner deleting
 * themselves must not take the friends' workspaces down with them; once
 * they're the last account it falls through to the full factory reset
 * (which restores the original single-user re-creation flow).
 */
export const wipeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.userId);
    const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
    const isOwner =
      !!owner && (user?.email ?? "").toLowerCase().trim() === owner;

    if (isOwner) {
      const others = (await ctx.db.query("users").collect()).filter(
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

    // Pages + sidecars.
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
      .collect();
    for (const p of pages) {
      const versions = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", p._id))
        .collect();
      for (const ver of versions) await ctx.db.delete("pageVersions", ver._id);
      const comments = await ctx.db
        .query("comments")
        .withIndex("by_page", (q) => q.eq("pageId", p._id))
        .collect();
      for (const c of comments) await ctx.db.delete("comments", c._id);
      await ctx.db.delete("pages", p._id);
    }

    // Shares: both directions — grants they made (their pages are being
    // deleted) and grants made to them (dangling recipient otherwise).
    const granted = await ctx.db.query("shares").collect();
    for (const s of granted) {
      if (s.ownerId === args.userId || s.userId === args.userId) {
        await ctx.db.delete("shares", s._id);
      }
    }

    // Files: rows and the stored objects themselves.
    const files = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
      .collect();
    for (const f of files) {
      await ctx.storage.delete(f.storageId).catch(() => {});
      await ctx.db.delete("files", f._id);
    }

    // AI usage rows.
    const usage = await ctx.db
      .query("aiUsage")
      .withIndex("by_user_month", (q) => q.eq("userId", args.userId))
      .collect();
    for (const u of usage) await ctx.db.delete("aiUsage", u._id);

    // Auth records: accounts and sessions by user (refresh tokens die with
    // their sessions), then the user doc. Redeemed invites stay as audit.
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", args.userId))
      .collect();
    for (const a of accounts) await ctx.db.delete("authAccounts", a._id);
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const s of sessions) await ctx.db.delete("authSessions", s._id);
    await ctx.db.delete("users", args.userId);
  },
});

async function wipeEverythingImpl(ctx: MutationCtx) {
  const tables: TableNames[] = [
    "pages",
    "pageVersions",
    "comments",
    "shares",
    "files",
    "aiUsage",
    "invites",
    // Auth state last; order within these doesn't matter — the whole
    // wipe is one transaction.
    "authSessions",
    "authRefreshTokens",
    "authVerificationCodes",
    "authVerifiers",
    "authRateLimits",
    "authAccounts",
    "users",
  ];
  for (const table of tables) {
    const docs = await ctx.db.query(table).collect();
    for (const doc of docs) {
      await ctx.db.delete(table, doc._id);
    }
  }
  const files = await ctx.db.system.query("_storage").collect();
  for (const file of files) {
    await ctx.storage.delete(file._id);
  }
}

/**
 * Full factory reset. Internal and reachable only through wipeUser's
 * owner-and-alone path (or ad-hoc CLI use in an emergency).
 */
export const wipeEverything = internalMutation({
  args: {},
  handler: async (ctx) => {
    await wipeEverythingImpl(ctx);
  },
});
