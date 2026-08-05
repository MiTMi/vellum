import { v, ConvexError } from "convex/values";
import {
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
} from "@convex-dev/auth/server";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { TableNames } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { assertPasswordPolicy } from "./lib/passwordPolicy";

/**
 * Account management for the (single) owner: change password, sign out of
 * every session, and the nuclear option — delete the account and erase the
 * workspace. Every entry point re-verifies the password with
 * `retrieveAccount`, the same scrypt check `signIn` uses, so a stolen open
 * session can't silently change or destroy the account.
 */

export const me = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    // Single-user workspace: the deployment's OWNER_EMAIL is the account
    // email by construction (convex/auth.ts refuses any other address).
    return { email: process.env.OWNER_EMAIL ?? null };
  },
});

/**
 * Throws a readable ConvexError unless `password` is the owner's. The cast
 * bridges our concrete DataModel to the library's generic ctx type — the
 * same shape, just contravariant.
 */
type AuthActionCtx = Parameters<typeof retrieveAccount>[0];

async function verifyOwnerPassword(
  ctx: unknown,
  password: string,
): Promise<string> {
  const email = process.env.OWNER_EMAIL?.toLowerCase().trim();
  if (!email) {
    throw new ConvexError("OWNER_EMAIL is not configured on this deployment.");
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
    await requireUser(ctx);
    const email = await verifyOwnerPassword(ctx, args.currentPassword);
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
    await requireUser(ctx);
    await verifyOwnerPassword(ctx, args.password);
    await ctx.runMutation(internal.account.wipeEverything, {});
  },
});

/**
 * Erase the workspace and the account: every page, version snapshot,
 * comment, uploaded file, and all auth records. Internal — reachable only
 * through deleteAccount's password gate. After this runs, the deployment is
 * factory-fresh: the login screen's "create the owner account" flow works
 * again (OWNER_EMAIL still applies).
 */
export const wipeEverything = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tables: TableNames[] = [
      "pages",
      "pageVersions",
      "comments",
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
  },
});
