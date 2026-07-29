import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
});

export default defineSchema({
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
    font: v.optional(
      v.union(v.literal("default"), v.literal("serif"), v.literal("mono")),
    ),
    smallText: v.optional(v.boolean()),
    fullWidth: v.optional(v.boolean()),
    locked: v.optional(v.boolean()),
    inTrash: v.optional(v.boolean()),
    trashRoot: v.optional(v.boolean()), // true only on the page the user trashed
    trashedAt: v.optional(v.number()),
    dbProps: v.optional(v.array(dbProp)),
    activeView: v.optional(
      v.union(v.literal("table"), v.literal("board"), v.literal("calendar")),
    ),
    boardGroupBy: v.optional(v.string()),
    calendarBy: v.optional(v.string()),
    updatedAt: v.number(),
    // Bumped only by content/title edits — the LWW conflict timestamp for
    // offline sync (a favorite-toggle must not beat a real edit).
    contentUpdatedAt: v.optional(v.number()),
    // Client-generated id of pages created offline; makes replayed
    // createWithDoc calls idempotent across crash/retry.
    clientKey: v.optional(v.string()),
  })
    .index("by_parent", ["parentId"])
    .index("by_clientKey", ["clientKey"])
    .searchIndex("search", { searchField: "searchText" }),
});
