import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { isOwnerUser } from "./auth";

/**
 * Per-user quotas (docs/multi-user-plan.md, decided 2026-08-09). The owner
 * (OWNER_EMAIL) is exempt from all of them. Values are deliberately plain
 * constants — changing a quota is a code change, reviewed like one.
 */

/** Max stored file bytes per user. Counts lifetime uploads (v1: rows in
 *  `files` are never reclaimed on page deletion — see schema note). */
export const FILE_QUOTA_BYTES = 50 * 1024 * 1024;

/** Max live + trashed pages per user. */
export const PAGE_QUOTA = 2000;

/** AI spend, micro-USD: per user per calendar month, and the shared pool
 *  for all non-owner users combined. */
export const AI_USER_MONTHLY_MICRO_USD = 100_000; // $0.10
export const AI_POOL_MONTHLY_MICRO_USD = 850_000; // $0.85

/** UTC calendar-month key, e.g. "2026-08". */
export function monthKey(now: number = Date.now()): string {
  const d = new Date(now);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

/** Total stored file bytes attributed to a user. */
export async function fileBytesOf(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<number> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();
  return rows.reduce((n, r) => n + r.size, 0);
}

/**
 * Throw unless the user may create `count` more pages. Called by every
 * page-creating mutation; the owner is exempt.
 */
export async function assertPageQuota(
  ctx: MutationCtx,
  userId: Id<"users">,
  count = 1,
): Promise<void> {
  if (await isOwnerUser(ctx, userId)) return;
  const existing = await ctx.db
    .query("pages")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();
  if (existing.length + count > PAGE_QUOTA) {
    throw new ConvexError(
      `Page limit reached (${PAGE_QUOTA}). Delete some pages from Trash to make room.`,
    );
  }
}

/** This month's AI spend for one user and for the whole non-owner pool. */
export async function aiSpend(
  ctx: QueryCtx,
  userId: Id<"users">,
  now: number = Date.now(),
): Promise<{ userMicro: number; poolMicro: number }> {
  const month = monthKey(now);
  const mine = await ctx.db
    .query("aiUsage")
    .withIndex("by_user_month", (q) => q.eq("userId", userId).eq("month", month))
    .unique();
  const all = await ctx.db
    .query("aiUsage")
    .withIndex("by_month", (q) => q.eq("month", month))
    .collect();
  return {
    userMicro: mine?.costMicroUsd ?? 0,
    // The owner is never recorded (exempt), so the month total IS the pool.
    poolMicro: all.reduce((n, r) => n + r.costMicroUsd, 0),
  };
}
