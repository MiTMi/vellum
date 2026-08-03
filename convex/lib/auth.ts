import { Auth } from "convex/server";
import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "../_generated/dataModel";

/**
 * Every public function in this backend must call this first — the whole
 * workspace is private to its (single) signed-in owner. Works in queries,
 * mutations, and actions alike.
 */
export async function requireUser(ctx: { auth: Auth }): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Not authenticated");
  }
  return userId;
}
