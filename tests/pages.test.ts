/// <reference types="vite/client" />
// Lives outside convex/ so the Convex CLI doesn't typecheck/bundle it.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob([
  "../convex/pages.ts",
  "../convex/files.ts",
  "../convex/schema.ts",
  "../convex/_generated/*.js",
]);

function t() {
  return convexTest(schema, modules);
}

test("bootstrap seeds a welcome page exactly once", async () => {
  const ctx = t();
  const first = await ctx.mutation(api.pages.bootstrap, {});
  expect(first).not.toBeNull();
  const again = await ctx.mutation(api.pages.bootstrap, {});
  expect(again).toBeNull();
  const pages = await ctx.query(api.pages.list, {});
  expect(pages).toHaveLength(1);
  expect(pages[0].title).toBe("Welcome to Vellum");
});

test("create page / nested pages / list tree fields", async () => {
  const ctx = t();
  const parent = await ctx.mutation(api.pages.create, { type: "doc", title: "Parent" });
  const child = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Child",
    parentId: parent,
  });
  const pages = await ctx.query(api.pages.list, {});
  const childMeta = pages.find((p) => p._id === child)!;
  expect(childMeta.parentId).toBe(parent);
  expect(childMeta.rank).toBeGreaterThan(0);
});

test("rename updates searchText and search finds it", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Alpha" });
  await ctx.mutation(api.pages.rename, { id, title: "Quarterly Roadmap" });
  const hits = await ctx.query(api.pages.search, { term: "Quarterly" });
  expect(hits.map((h) => h._id)).toContain(id);
});

test("updateContent persists blocks and indexes body text", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });
  const blocks = [
    { type: "paragraph", content: [{ type: "text", text: "flamingo migration", styles: {} }] },
  ];
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: blocks,
    text: "flamingo migration",
  });
  const doc = await ctx.query(api.pages.get, { id });
  expect(doc?.content).toEqual(blocks);
  const hits = await ctx.query(api.pages.search, { term: "flamingo" });
  expect(hits.map((h) => h._id)).toContain(id);
});

test("icon and cover set/clear", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc" });
  await ctx.mutation(api.pages.setIcon, { id, icon: "🔥" });
  await ctx.mutation(api.pages.setCover, { id, cover: "gradient:2" });
  let doc = await ctx.query(api.pages.get, { id });
  expect(doc?.icon).toBe("🔥");
  expect(doc?.cover).toBe("gradient:2");
  await ctx.mutation(api.pages.setIcon, { id, icon: null });
  await ctx.mutation(api.pages.setCover, { id, cover: null });
  doc = await ctx.query(api.pages.get, { id });
  expect(doc?.icon).toBeUndefined();
  expect(doc?.cover).toBeUndefined();
});

test("move prevents cycles", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await ctx.mutation(api.pages.create, { type: "doc", title: "B", parentId: a });
  // Try to move A under B (its own descendant) — must be a no-op.
  await ctx.mutation(api.pages.move, { id: a, parentId: b, rank: 1 });
  const pages = await ctx.query(api.pages.list, {});
  const aMeta = pages.find((p) => p._id === a)!;
  expect(aMeta.parentId).toBeNull();
  // Legal move: B to root.
  await ctx.mutation(api.pages.move, { id: b, rank: 99 });
  const bMeta = (await ctx.query(api.pages.list, {})).find((p) => p._id === b)!;
  expect(bMeta.parentId).toBeNull();
  expect(bMeta.rank).toBe(99);
});

test("trash hides subtree, restore brings it back", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await ctx.mutation(api.pages.create, { type: "doc", title: "B", parentId: a });
  await ctx.mutation(api.pages.trash, { id: a });
  let pages = await ctx.query(api.pages.list, {});
  expect(pages).toHaveLength(0);
  const trashed = await ctx.query(api.pages.trashed, {});
  expect(trashed).toHaveLength(1); // only the root shows in trash
  expect(trashed[0]._id).toBe(a);
  await ctx.mutation(api.pages.restore, { id: a });
  pages = await ctx.query(api.pages.list, {});
  expect(pages).toHaveLength(2);
  const bMeta = pages.find((p) => p._id === b)!;
  expect(bMeta.parentId).toBe(a);
});

test("restoring a child of a trashed parent moves it to root", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await ctx.mutation(api.pages.create, { type: "doc", title: "B", parentId: a });
  await ctx.mutation(api.pages.trash, { id: b });
  await ctx.mutation(api.pages.trash, { id: a });
  await ctx.mutation(api.pages.restore, { id: b });
  const pages = await ctx.query(api.pages.list, {});
  const bMeta = pages.find((p) => p._id === b)!;
  expect(bMeta.parentId).toBeNull();
});

test("deleteForever removes subtree permanently; emptyTrash clears all", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  await ctx.mutation(api.pages.create, { type: "doc", title: "B", parentId: a });
  const c = await ctx.mutation(api.pages.create, { type: "doc", title: "C" });
  await ctx.mutation(api.pages.trash, { id: a });
  await ctx.mutation(api.pages.deleteForever, { id: a });
  expect(await ctx.query(api.pages.trashed, {})).toHaveLength(0);
  await ctx.mutation(api.pages.trash, { id: c });
  await ctx.mutation(api.pages.emptyTrash, {});
  expect(await ctx.query(api.pages.trashed, {})).toHaveLength(0);
  expect(await ctx.query(api.pages.list, {})).toHaveLength(0);
});

test("duplicate clones subtree with ' (copy)' suffix", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "Notes" });
  await ctx.mutation(api.pages.create, { type: "doc", title: "Inner", parentId: a });
  const copyId = await ctx.mutation(api.pages.duplicate, { id: a });
  expect(copyId).not.toBeNull();
  const pages = await ctx.query(api.pages.list, {});
  expect(pages).toHaveLength(4);
  const copy = pages.find((p) => p._id === copyId)!;
  expect(copy.title).toBe("Notes (copy)");
  const innerCopy = pages.find((p) => p.parentId === copyId)!;
  expect(innerCopy.title).toBe("Inner");
});

test("database defaults, row props, views", async () => {
  const ctx = t();
  const db = await ctx.mutation(api.pages.create, { type: "database", title: "Tasks" });
  const doc = await ctx.query(api.pages.get, { id: db });
  expect(doc?.dbProps?.length).toBe(3);
  expect(doc?.activeView).toBe("table");

  const row = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Ship it",
    parentId: db,
    props: { status: "todo" },
  });
  await ctx.mutation(api.pages.setRowProp, { id: row, propId: "status", value: "done" });
  let rowDoc = await ctx.query(api.pages.get, { id: row });
  expect(rowDoc?.props?.status).toBe("done");
  await ctx.mutation(api.pages.setRowProp, { id: row, propId: "status", value: null });
  rowDoc = await ctx.query(api.pages.get, { id: row });
  expect(rowDoc?.props?.status).toBeUndefined();

  await ctx.mutation(api.pages.setView, { id: db, activeView: "board", boardGroupBy: "status" });
  const dbDoc = await ctx.query(api.pages.get, { id: db });
  expect(dbDoc?.activeView).toBe("board");

  // Property schema editing
  await ctx.mutation(api.pages.updateDbProps, {
    id: db,
    dbProps: [
      { id: "status", name: "Stage", type: "select", options: [{ id: "x", name: "X", color: "red" }] },
      { id: "est", name: "Estimate", type: "number" },
    ],
  });
  const updated = await ctx.query(api.pages.get, { id: db });
  expect(updated?.dbProps?.map((p) => p.name)).toEqual(["Stage", "Estimate"]);
});

test("favorites toggle and clear on trash", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Fav" });
  await ctx.mutation(api.pages.toggleFavorite, { id });
  let meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === id)!;
  expect(meta.isFavorite).toBe(true);
  await ctx.mutation(api.pages.trash, { id });
  await ctx.mutation(api.pages.restore, { id });
  meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === id)!;
  expect(meta.isFavorite).toBe(false);
});
