import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Scheduled jobs.
 *
 * One so far: the storage safety net. `pages.deleteForever` / `emptyTrash`
 * already reclaim a deleted page's blobs immediately (files._reclaimKeys),
 * so this exists for what that path structurally cannot see —
 *
 *  - uploads abandoned before the block referencing them was ever saved,
 *  - blobs that predate the `files` table entirely,
 *  - references freed when a history snapshot ages out past
 *    MAX_VERSIONS_PER_PAGE rather than by any deletion.
 *
 * Runs at 04:00 UTC, off the usual usage peak. `_sweep` keeps its own
 * 24-hour grace period and per-pass caps, so a run is bounded and a
 * freshly uploaded file is never in scope.
 */
const crons = cronJobs();

// `crons.cron`, not the `crons.daily` helper: convex/_generated/ai/
// guidelines.md allows only `interval` and `cron`.
crons.cron(
  "reclaim unreferenced files",
  "0 4 * * *", // 04:00 UTC daily
  internal.files._sweep,
  {},
);

export default crons;
