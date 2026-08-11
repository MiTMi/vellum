/// <reference types="vite/client" />
// Shared convex-test harness. Since multi-tenancy (Phase 1), functions
// stamp and compare real `Id<"users">` values — so test identities must be
// backed by real `users` rows, with the id in the subject's first segment
// (getAuthUserId parses `${userId}|${sessionId}`).
import { convexTest } from "convex-test";
import schema from "../convex/schema";

export const modules = import.meta.glob([
  "../convex/pages.ts",
  "../convex/shares.ts",
  "../convex/ai.ts",
  "../convex/account.ts",
  "../convex/admin.ts",
  "../convex/files.ts",
  "../convex/versions.ts",
  "../convex/comments.ts",
  "../convex/migrate.ts",
  "../convex/schema.ts",
  "../convex/lib/*.ts",
  "../convex/_generated/*.js",
]);

/** The owner's email — functions read OWNER_EMAIL for quota exemption. */
export const OWNER_EMAIL = "owner@vellum.test";
process.env.OWNER_EMAIL = OWNER_EMAIL;

export type TestConvex = ReturnType<typeof convexTest>;
export type TestAccessor = ReturnType<TestConvex["withIdentity"]>;

export function freshBackend(): TestConvex {
  return convexTest(schema, modules);
}

/** Create a real user row on `tc` and return an accessor signed in as them. */
export async function addUser(
  tc: TestConvex,
  email: string,
): Promise<{ userId: string; as: TestAccessor }> {
  const userId = await tc.run(async (ctx) => {
    return await ctx.db.insert("users", { email });
  });
  return { userId, as: tc.withIdentity({ subject: `${userId}|testsession` }) };
}

/** Fresh backend with the owner signed in — the common single-user case. */
export async function ownerBackend(): Promise<{
  tc: TestConvex;
  userId: string;
  as: TestAccessor;
}> {
  const tc = freshBackend();
  const { userId, as } = await addUser(tc, OWNER_EMAIL);
  return { tc, userId, as };
}

/** Fresh backend with a regular (non-owner) user signed in. */
export async function userBackend(): Promise<{
  tc: TestConvex;
  userId: string;
  as: TestAccessor;
}> {
  const tc = freshBackend();
  const { userId, as } = await addUser(tc, "friend@vellum.test");
  return { tc, userId, as };
}
