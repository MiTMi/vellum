import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import { assertPasswordPolicy } from "./lib/passwordPolicy";

/**
 * Vellum is a single-user workspace: only the owner may hold an account.
 * OWNER_EMAIL is a deployment env var; sign-up (and password sign-in, which
 * shares the profile step) is rejected for any other address. Fail closed —
 * an unset OWNER_EMAIL means nobody can sign up, not everybody.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      // Runs on signUp / password reset only — never on signIn, so the
      // existing account keeps working regardless of when it was created.
      validatePasswordRequirements: assertPasswordPolicy,
      profile(params) {
        const owner = process.env.OWNER_EMAIL?.toLowerCase().trim();
        const email = String(params.email ?? "")
          .toLowerCase()
          .trim();
        if (!owner || email !== owner) {
          throw new ConvexError("This workspace belongs to someone else.");
        }
        return { email };
      },
    }),
  ],
});
