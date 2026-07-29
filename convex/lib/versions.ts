/**
 * Page-history snapshot policy, shared by the server (convex/pages.ts) and
 * mock mode's sidecar history (src/data/mock.ts) so both capture versions on
 * the same schedule.
 */

/** Minimum gap between two snapshots of the same page. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/** Snapshots kept per page; older ones are pruned on capture. */
export const MAX_VERSIONS_PER_PAGE = 30;

/**
 * Should an edit landing at `now` capture the page's *previous* content?
 * `lastSavedAt` is the newest existing snapshot (undefined = none yet).
 */
export function shouldSnapshot(
  lastSavedAt: number | undefined,
  now: number,
  intervalMs: number = SNAPSHOT_INTERVAL_MS,
): boolean {
  if (lastSavedAt === undefined) return true;
  return now - lastSavedAt >= intervalMs;
}
