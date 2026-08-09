import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import { DataModel } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { redeemInviteForNewUser } from "./lib/invites";
import { assertPasswordPolicy } from "./lib/passwordPolicy";

/**
 * Multi-tenant sign-up, gated by invite codes (Phase 1 of
 * docs/multi-user-plan.md). The owner (OWNER_EMAIL) may always sign up —
 * that preserves the factory-reset → re-create flow — while everyone else
 * needs an unredeemed code minted by the owner (convex/admin.ts).
 *
 * The check lives in `afterUserCreatedOrUpdated`, which runs inside the
 * same mutation that creates the user: an invalid code aborts the whole
 * sign-up transactionally, and two sign-ups racing one code conflict on
 * the invite row, so exactly one account wins. Password policy runs even
 * earlier (in `authorize`, before any write), so a weak password can never
 * burn a code.
 *
 * The code travels from the sign-up form to the callback as a transient
 * `inviteCode` field on the user profile (the users table declares it),
 * and is cleared before the transaction commits.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({
      // Runs on signUp / password reset only — never on signIn, so an
      // existing account keeps working regardless of when it was created.
      validatePasswordRequirements: assertPasswordPolicy,
      profile(params) {
        const email = String(params.email ?? "")
          .toLowerCase()
          .trim();
        if (!email) throw new ConvexError("An email address is required.");
        // Only relevant for the signUp flow; profile() must stay synchronous
        // (its result is not awaited), so validation happens in the callback
        // below, where a database transaction is available.
        const inviteCode = String(params.inviteCode ?? "").trim();
        if (params.flow === "signUp" && inviteCode) {
          return { email, inviteCode };
        }
        return { email };
      },
    }),
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(genericCtx, args) {
      // Only gate brand-new accounts; sign-ins to existing ones pass.
      if (args.existingUserId) return;
      // The callback is typed over AnyDataModel; the runtime ctx is ours.
      const ctx = genericCtx as unknown as MutationCtx;
      await redeemInviteForNewUser(ctx, args.userId);
    },
  },
});
