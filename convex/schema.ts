import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Vellum data model.
 *
 * Everything is a page — documents, databases, and database rows alike
 * (exactly like Notion). A page whose `type` is "database" carries a
 * property schema (`dbProps`) and its children are its rows. Rows carry
 * `props` (property values keyed by property id) and can still have full
 * rich-text `content`, so every row opens as a real page.
 */

export const propType = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("select"),
  v.literal("multiSelect"),
  v.literal("date"),
  v.literal("checkbox"),
  v.literal("url"),
  v.literal("relation"),
  // Computed, never stored: read off the row's own timestamps.
  v.literal("createdTime"),
  v.literal("lastEditedTime"),
  // Computed: aggregates a property of related rows through a relation.
  v.literal("rollup"),
  // Computed: an expression over this row's other properties.
  v.literal("formula"),
);

export const dbProp = v.object({
  id: v.string(),
  name: v.string(),
  type: propType,
  width: v.optional(v.number()),
  options: v.optional(
    v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        color: v.string(),
      }),
    ),
  ),
  // Relation properties: the database page whose rows this prop links to.
  // Deliberately v.string(), not v.id("pages") — offline clients hold temp
  // ids until their create replays, and dbProps ride through createWithDoc.
  targetId: v.optional(v.string()),
  // Rollup properties. All three hold client-generated prop ids (or the
  // "__title" sentinel), never page ids — nothing here needs id remapping.
  relationPropId: v.optional(v.string()), // which relation column to follow
  rollupPropId: v.optional(v.string()), // which property of the target rows
  rollupCalc: v.optional(v.string()), // count | sum | avg | min | max | …
  // Formula properties: the expression source (see src/lib/formula.ts).
  // Evaluated client-side at render; never stored as a value.
  formula: v.optional(v.string()),
});

export const activeView = v.union(
  v.literal("table"),
  v.literal("board"),
  v.literal("calendar"),
  v.literal("gallery"),
  v.literal("timeline"),
);

export default defineSchema({
  // Convex Auth's account/session/user tables. The whole workspace is
  // single-tenant: functions gate on "is the owner signed in" (see
  // lib/auth.ts) rather than per-document ownership.
  ...authTables,

  pages: defineTable({
    title: v.string(),
    type: v.union(v.literal("doc"), v.literal("database")),
    parentId: v.optional(v.id("pages")),
    rank: v.number(),
    icon: v.optional(v.string()),
    cover: v.optional(v.string()), // css gradient token ("gradient:N") or a URL
    content: v.optional(v.any()), // BlockNote Block[]
    contentText: v.optional(v.string()), // plain-text extraction of content
    searchText: v.optional(v.string()), // title + contentText (search index field)
    props: v.optional(v.record(v.string(), v.any())), // row property values
    isFavorite: v.optional(v.boolean()),
    // Marks a page as a reusable template — excluded from the page tree and
    // listed in the sidebar's Templates section instead.
    isTemplate: v.optional(v.boolean()),
    font: v.optional(
      v.union(v.literal("default"), v.literal("serif"), v.literal("mono")),
    ),
    smallText: v.optional(v.boolean()),
    fullWidth: v.optional(v.boolean()),
    locked: v.optional(v.boolean()),
    // End-to-end encrypted Vault. True on the vault root and every
    // descendant (denormalized so guards never walk the parent chain).
    // Vault pages carry client-encrypted `title`/`content` and empty
    // search fields — the server never sees their plaintext.
    vault: v.optional(v.boolean()),
    inTrash: v.optional(v.boolean()),
    trashRoot: v.optional(v.boolean()), // true only on the page the user trashed
    trashedAt: v.optional(v.number()),
    dbProps: v.optional(v.array(dbProp)),
    activeView: v.optional(activeView),
    boardGroupBy: v.optional(v.string()),
    calendarBy: v.optional(v.string()),
    updatedAt: v.number(),
    // Bumped only by content/title edits — the LWW conflict timestamp for
    // offline sync (a favorite-toggle must not beat a real edit).
    contentUpdatedAt: v.optional(v.number()),
    // Client-generated id of pages created offline; makes replayed
    // createWithDoc calls idempotent across crash/retry.
    clientKey: v.optional(v.string()),
    // "Publish to web": an unguessable slug serving this page publicly at
    // /p/<slug>. Absent means private — the slug IS the access control, so
    // unpublishing must clear it rather than flag it.
    publicSlug: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
  })
    .index("by_parent", ["parentId"])
    .index("by_clientKey", ["clientKey"])
    .index("by_publicSlug", ["publicSlug"])
    .searchIndex("search", { searchField: "searchText" }),

  /**
   * Point-in-time snapshots of a page's content, captured server-side by
   * `updateContent` at most once per SNAPSHOT_INTERVAL_MS. Deliberately a
   * separate table: the offline replica mirrors `pages` only, so history
   * never touches the sync index, reconcile, or the outbox.
   */
  pageVersions: defineTable({
    pageId: v.id("pages"),
    title: v.string(),
    content: v.optional(v.any()),
    savedAt: v.number(),
  }).index("by_page", ["pageId", "savedAt"]),

  /**
   * Page comments. Like pageVersions, a separate table the offline replica
   * never mirrors — so commenting touches neither `syncIndex`, reconcile,
   * nor the outbox, and is simply unavailable while offline.
   */
  comments: defineTable({
    pageId: v.id("pages"),
    text: v.string(),
    createdAt: v.number(),
    resolved: v.optional(v.boolean()),
  }).index("by_page", ["pageId", "createdAt"]),
});
