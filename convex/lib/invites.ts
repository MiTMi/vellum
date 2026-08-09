import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/**
 * The invite gate for brand-new accounts, run inside the same mutation
 * that creates the user (auth.ts `afterUserCreatedOrUpdated`) — throwing
 * here aborts the whole sign-up. Extracted so tests can drive it directly;
 * the auth callback is not reachable from convex-test.
 */
export async function redeemInviteForNewUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get("users", userId);
  const email = (user?.email ?? "").toLowerCase().trim();
  const code =
    typeof user?.inviteCode === "string" ? user.inviteCode.trim() : "";

  // The code is transport, not data — never leave it on the user doc.
  if (user && user.inviteCode !== undefined) {
    await ctx.db.patch("users", userId, { inviteCode: undefined });
  }

  const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
  if (owner && email === owner) return; // the owner needs no invite

  if (!code) {
    throw new ConvexError("An invite code is required to sign up.");
  }
  const invite = await ctx.db
    .query("invites")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
  if (!invite || invite.redeemedBy) {
    throw new ConvexError("That invite code is not valid.");
  }
  await ctx.db.patch("invites", invite._id, {
    redeemedBy: userId,
    redeemedAt: Date.now(),
  });
}
