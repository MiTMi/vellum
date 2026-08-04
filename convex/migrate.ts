import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * One-off migration helpers, driven from the CLI:
 *
 *   npx convex run migrate:rewriteHostBatch \
 *     '{"from":"https://old.convex.cloud","to":"https://new.convex.cloud","cursor":null}' --prod
 *
 * Everything here is an `internalMutation` on purpose: these rewrite user
 * data in bulk and must stay unreachable from any client. Loop on the
 * returned `cursor` until `isDone`.
 *
 * Why a host rewrite is needed at all: uploaded images and covers are stored
 * as absolute `https://<deployment>.convex.cloud/api/storage/<id>` URLs
 * inside page content, so moving the data to another deployment leaves every
 * one of them pointing at the old backend.
 */

const BATCH = 100;

/**
 * Replace every occurrence of `from` with `to` inside an arbitrary stored
 * value, via a JSON round-trip. Literal `split`/`join` rather than a regex —
 * the needle is a URL, and escaping it for `RegExp` buys nothing.
 *
 * Returns the original value untouched when nothing matched, so callers can
 * skip the patch (and the timestamp bump) for pages that hold no file URLs.
 */
function swapHost<T>(
  value: T,
  from: string,
  to: string,
): { value: T; changed: boolean } {
  if (value === undefined || value === null) return { value, changed: false };
  const json = JSON.stringify(value);
  if (json === undefined || !json.includes(from)) return { value, changed: false };
  return { value: JSON.parse(json.split(from).join(to)) as T, changed: true };
}

/**
 * Sweep one page of the `pages` table.
 *
 * Rewritten rows get `updatedAt` **and** `contentUpdatedAt` bumped: the first
 * is the repo-wide invariant every page-patching mutation obeys (reconcile
 * diffs on it), the second makes offline replicas treat the rewritten copy as
 * the LWW winner and re-pull it. Only rows that actually changed are patched,
 * so this doesn't churn the whole workspace.
 */
export const rewriteHostBatch = internalMutation({
  args: {
    from: v.string(),
    to: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("pages")
      .paginate({ numItems: args.numItems ?? BATCH, cursor: args.cursor });

    let rewritten = 0;
    for (const doc of page) {
      const content = swapHost(doc.content, args.from, args.to);
      const cover = swapHost(doc.cover, args.from, args.to);
      const props = swapHost(doc.props, args.from, args.to);
      // Derived plain text — swept too so the search index can't keep
      // matching the retired deployment name.
      const contentText = swapHost(doc.contentText, args.from, args.to);
      const searchText = swapHost(doc.searchText, args.from, args.to);

      if (
        !content.changed &&
        !cover.changed &&
        !props.changed &&
        !contentText.changed &&
        !searchText.changed
      ) {
        continue;
      }

      const now = Date.now();
      await ctx.db.patch("pages", doc._id, {
        ...(content.changed ? { content: content.value } : {}),
        ...(cover.changed ? { cover: cover.value } : {}),
        ...(props.changed ? { props: props.value } : {}),
        ...(contentText.changed ? { contentText: contentText.value } : {}),
        ...(searchText.changed ? { searchText: searchText.value } : {}),
        updatedAt: now,
        contentUpdatedAt: now,
      });
      rewritten++;
    }

    return {
      isDone,
      cursor: isDone ? null : continueCursor,
      scanned: page.length,
      rewritten,
    };
  },
});

/**
 * Same sweep over history snapshots. `pageVersions` is outside the replica
 * (no sync index, no reconcile), so there are no timestamps to bump — the
 * only field that can hold a file URL is `content`.
 */
export const rewriteVersionHostBatch = internalMutation({
  args: {
    from: v.string(),
    to: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("pageVersions")
      .paginate({ numItems: args.numItems ?? BATCH, cursor: args.cursor });

    let rewritten = 0;
    for (const doc of page) {
      const content = swapHost(doc.content, args.from, args.to);
      if (!content.changed) continue;
      await ctx.db.patch("pageVersions", doc._id, { content: content.value });
      rewritten++;
    }

    return {
      isDone,
      cursor: isDone ? null : continueCursor,
      scanned: page.length,
      rewritten,
    };
  },
});
