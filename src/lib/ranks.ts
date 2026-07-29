import { PageMeta } from "./types";

/** Compute a rank that places an item between `before` and `after`. */
export function rankBetween(
  before: PageMeta | null,
  after: PageMeta | null,
): number {
  if (before && after) return (before.rank + after.rank) / 2;
  if (before) return before.rank + 1024;
  if (after) return after.rank / 2;
  return 1024;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
