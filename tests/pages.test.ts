/// <reference types="vite/client" />
// Lives outside convex/ so the Convex CLI doesn't typecheck/bundle it.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob([
  "../convex/pages.ts",
  "../convex/files.ts",
  "../convex/versions.ts",
  "../convex/comments.ts",
  "../convex/migrate.ts",
  "../convex/schema.ts",
  "../convex/lib/*.ts",
  "../convex/_generated/*.js",
]);

// Every function requires a signed-in user (see convex/lib/auth.ts), so the
// default accessor carries the owner's identity. `subject` mimics Convex
// Auth's "<userId>|<sessionId>" shape.
function t() {
  return convexTest(schema, modules).withIdentity({ subject: "owner|test" });
}

test("unauthenticated calls are rejected", async () => {
  const anon = convexTest(schema, modules);
  await expect(anon.query(api.pages.list, {})).rejects.toThrow(
    /Not authenticated/,
  );
  await expect(
    anon.mutation(api.pages.create, { type: "doc", title: "nope" }),
  ).rejects.toThrow(/Not authenticated/);
});

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

test("backlinks lists linking pages, excluding trashed and self", async () => {
  const ctx = t();
  const target = await ctx.mutation(api.pages.create, { type: "doc", title: "Target" });
  const src1 = await ctx.mutation(api.pages.create, { type: "doc", title: "Src1" });
  const src2 = await ctx.mutation(api.pages.create, { type: "doc", title: "Src2" });
  const link = { type: "pageLink", props: { pageId: target }, content: [] };
  await ctx.mutation(api.pages.updateContent, { id: src1, content: [link], text: "" });
  // Nested inside children — must still count.
  await ctx.mutation(api.pages.updateContent, {
    id: src2,
    content: [{ type: "paragraph", content: [], children: [link] }],
    text: "",
  });
  // A self-link must not count.
  await ctx.mutation(api.pages.updateContent, { id: target, content: [link], text: "" });

  let backs = await ctx.query(api.pages.backlinks, { id: target });
  expect(backs.map((b) => b.title).sort()).toEqual(["Src1", "Src2"]);

  await ctx.mutation(api.pages.trash, { id: src1 });
  backs = await ctx.query(api.pages.backlinks, { id: target });
  expect(backs.map((b) => b.title)).toEqual(["Src2"]);

  // Pages that merely mention text don't count.
  expect(await ctx.query(api.pages.backlinks, { id: src2 })).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Offline sync support                                                */
/* ------------------------------------------------------------------ */

test("syncIndex lists every page including trashed, drops deleted", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await ctx.mutation(api.pages.create, { type: "doc", title: "B" });
  await ctx.mutation(api.pages.trash, { id: a });
  let index = await ctx.query(api.pages.syncIndex, {});
  expect(index.map((e) => e._id).sort()).toEqual([a, b].sort());
  await ctx.mutation(api.pages.deleteForever, { id: a });
  index = await ctx.query(api.pages.syncIndex, {});
  expect(index.map((e) => e._id)).toEqual([b]);
});

test("getMany returns full docs and skips missing ids", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await ctx.mutation(api.pages.create, { type: "doc", title: "B" });
  await ctx.mutation(api.pages.trash, { id: b });
  await ctx.mutation(api.pages.deleteForever, { id: b });
  const docs = await ctx.query(api.pages.getMany, { ids: [a, b] });
  expect(docs).toHaveLength(1);
  expect(docs[0]._id).toBe(a);
  expect(docs[0].title).toBe("A");
});

test("every page-patching mutation bumps updatedAt", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "X" });
  const stamp = async () =>
    (await ctx.query(api.pages.get, { id }))!.updatedAt;
  let prev = await stamp();
  const steps: Array<() => Promise<unknown>> = [
    () => ctx.mutation(api.pages.toggleFavorite, { id }),
    () => ctx.mutation(api.pages.setPageOptions, { id, locked: true }),
    () => ctx.mutation(api.pages.move, { id, rank: 5000 }),
    () => ctx.mutation(api.pages.setView, { id, activeView: "table" }),
    () => ctx.mutation(api.pages.trash, { id }),
    () => ctx.mutation(api.pages.restore, { id }),
  ];
  for (const step of steps) {
    await new Promise((r) => setTimeout(r, 2));
    await step();
    const next = await stamp();
    expect(next).toBeGreaterThan(prev);
    prev = next;
  }
});

test("patch mutations no-op on deleted pages instead of throwing", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Gone" });
  await ctx.mutation(api.pages.trash, { id });
  await ctx.mutation(api.pages.deleteForever, { id });
  await ctx.mutation(api.pages.setIcon, { id, icon: "🔥" });
  await ctx.mutation(api.pages.setCover, { id, cover: "gradient:1" });
  await ctx.mutation(api.pages.setPageOptions, { id, locked: true });
  await ctx.mutation(api.pages.move, { id, rank: 1 });
  await ctx.mutation(api.pages.setView, { id, activeView: "board" });
  await ctx.mutation(api.pages.rename, { id, title: "Zombie" });
  await ctx.mutation(api.pages.updateContent, { id, content: [], text: "" });
  expect(await ctx.query(api.pages.get, { id })).toBeNull();
});

test("createWithDoc is idempotent via clientKey", async () => {
  const ctx = t();
  const args = {
    clientKey: "local_abc123",
    title: "Offline page",
    type: "doc" as const,
    rank: 1024,
    searchText: "Offline page",
    updatedAt: 1000,
  };
  const first = await ctx.mutation(api.pages.createWithDoc, args);
  const second = await ctx.mutation(api.pages.createWithDoc, args);
  expect(second).toBe(first);
  expect(await ctx.query(api.pages.list, {})).toHaveLength(1);
});

test("duplicate does not copy clientKey", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.createWithDoc, {
    clientKey: "local_dup",
    title: "Src",
    type: "doc",
    rank: 1024,
    updatedAt: 1000,
  });
  const copy = await ctx.mutation(api.pages.duplicate, { id });
  const copyDoc = await ctx.query(api.pages.get, { id: copy! });
  expect(copyDoc?.clientKey).toBeUndefined();
  // Replaying the original create must still return the original, not throw.
  const replay = await ctx.mutation(api.pages.createWithDoc, {
    clientKey: "local_dup",
    title: "Src",
    type: "doc",
    rank: 1024,
    updatedAt: 1000,
  });
  expect(replay).toBe(id);
});

test("updateContent/rename LWW: older replayed edit loses, newer wins", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: [{ type: "paragraph" }],
    text: "newer",
    clientUpdatedAt: 2000,
  });
  // Stale offline edit from before — must be discarded.
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: [],
    text: "older",
    clientUpdatedAt: 1000,
  });
  let doc = await ctx.query(api.pages.get, { id });
  expect(doc?.contentText).toBe("newer");
  await ctx.mutation(api.pages.rename, { id, title: "Stale", clientUpdatedAt: 1500 });
  doc = await ctx.query(api.pages.get, { id });
  expect(doc?.title).toBe("Doc");
  // Newer edits still land.
  await ctx.mutation(api.pages.rename, { id, title: "Fresh", clientUpdatedAt: 3000 });
  doc = await ctx.query(api.pages.get, { id });
  expect(doc?.title).toBe("Fresh");
  expect(doc?.contentUpdatedAt).toBe(3000);
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

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

test("setTemplate is absolute and surfaces in list", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Meeting" });
  let meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === id)!;
  expect(meta.isTemplate).toBe(false);

  await ctx.mutation(api.pages.setTemplate, { id, value: true });
  meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === id)!;
  expect(meta.isTemplate).toBe(true);

  // Replaying the same absolute op must not flip it back.
  await ctx.mutation(api.pages.setTemplate, { id, value: true });
  meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === id)!;
  expect(meta.isTemplate).toBe(true);

  await ctx.mutation(api.pages.setTemplate, { id, value: false });
  meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === id)!;
  expect(meta.isTemplate).toBe(false);
});

test("duplicate asInstance clears the template flag and reparents", async () => {
  const ctx = t();
  const tpl = await ctx.mutation(api.pages.create, { type: "doc", title: "Weekly" });
  await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Agenda",
    parentId: tpl,
  });
  await ctx.mutation(api.pages.setTemplate, { id: tpl, value: true });

  const instance = (await ctx.mutation(api.pages.duplicate, {
    id: tpl,
    toRoot: true,
    suffix: "",
    asInstance: true,
  }))!;
  const pages = await ctx.query(api.pages.list, {});
  const inst = pages.find((p) => p._id === instance)!;
  expect(inst.title).toBe("Weekly");
  expect(inst.isTemplate).toBe(false);
  expect(inst.parentId).toBeNull();
  // The whole subtree comes along.
  expect(pages.filter((p) => p.parentId === instance)).toHaveLength(1);
  // The template itself is untouched.
  expect(pages.find((p) => p._id === tpl)!.isTemplate).toBe(true);
});

test("plain duplicate still copies alongside with a suffix", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Notes" });
  const copy = (await ctx.mutation(api.pages.duplicate, { id }))!;
  const meta = (await ctx.query(api.pages.list, {})).find((p) => p._id === copy)!;
  expect(meta.title).toBe("Notes (copy)");
});

test("createWithDoc accepts isTemplate and gallery view", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.createWithDoc, {
    clientKey: "local_tpl",
    title: "Offline template",
    type: "database",
    rank: 1024,
    isTemplate: true,
    activeView: "gallery",
    updatedAt: 5,
  });
  const doc = await ctx.query(api.pages.get, { id });
  expect(doc?.isTemplate).toBe(true);
  expect(doc?.activeView).toBe("gallery");
});

/* ------------------------------------------------------------------ */
/* Relations                                                           */
/* ------------------------------------------------------------------ */

test("relation props round-trip through updateDbProps and setRowProp", async () => {
  const ctx = t();
  const projects = await ctx.mutation(api.pages.create, {
    type: "database",
    title: "Projects",
  });
  const tasks = await ctx.mutation(api.pages.create, {
    type: "database",
    title: "Tasks",
  });
  const projectRow = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Apollo",
    parentId: projects,
  });
  const taskRow = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Ship it",
    parentId: tasks,
  });

  await ctx.mutation(api.pages.updateDbProps, {
    id: tasks,
    dbProps: [{ id: "proj", name: "Project", type: "relation", targetId: projects }],
  });
  await ctx.mutation(api.pages.setRowProp, {
    id: taskRow,
    propId: "proj",
    value: [projectRow],
  });

  const db = await ctx.query(api.pages.get, { id: tasks });
  expect(db?.dbProps?.[0].targetId).toBe(projects);
  const row = await ctx.query(api.pages.get, { id: taskRow });
  expect(row?.props?.proj).toEqual([projectRow]);
});

/* ------------------------------------------------------------------ */
/* Page history                                                        */
/* ------------------------------------------------------------------ */

const para = (text: string) => [
  { type: "paragraph", content: [{ type: "text", text, styles: {} }] },
];

test("updateContent snapshots the previous content, throttled", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });

  // First write has no previous content — nothing to snapshot.
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: para("v1"),
    text: "v1",
  });
  expect(await ctx.query(api.versions.list, { pageId: id })).toHaveLength(0);

  // Second write snapshots v1.
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: para("v2"),
    text: "v2",
  });
  let versions = await ctx.query(api.versions.list, { pageId: id });
  expect(versions).toHaveLength(1);

  // A third write moments later is inside the throttle window.
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: para("v3"),
    text: "v3",
  });
  versions = await ctx.query(api.versions.list, { pageId: id });
  expect(versions).toHaveLength(1);

  const snap = await ctx.query(api.versions.get, { id: versions[0]._id });
  expect(snap?.content).toEqual(para("v1"));
});

test("a write past the throttle window captures another snapshot", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });
  // clientUpdatedAt drives `now`. It must stay monotonically ahead of the
  // first write's wall-clock stamp or last-writer-wins discards it.
  const t0 = Date.now() + 1000;
  await ctx.mutation(api.pages.updateContent, { id, content: para("a"), text: "a" });
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: para("b"),
    text: "b",
    clientUpdatedAt: t0,
  });
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: para("c"),
    text: "c",
    clientUpdatedAt: t0 + 11 * 60 * 1000,
  });
  const versions = await ctx.query(api.versions.list, { pageId: id });
  expect(versions).toHaveLength(2);
  // Newest first.
  expect(versions[0].savedAt).toBeGreaterThan(versions[1].savedAt);
});

test("deleteForever removes a page's history", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });
  await ctx.mutation(api.pages.updateContent, { id, content: para("a"), text: "a" });
  await ctx.mutation(api.pages.updateContent, { id, content: para("b"), text: "b" });
  expect(await ctx.query(api.versions.list, { pageId: id })).toHaveLength(1);

  await ctx.mutation(api.pages.trash, { id });
  await ctx.mutation(api.pages.deleteForever, { id });
  expect(await ctx.query(api.versions.list, { pageId: id })).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* Search snippets                                                     */
/* ------------------------------------------------------------------ */

test("search returns a body snippet, or null when only the title matched", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Zoology",
  });
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: para("the aardvark forages at night"),
    text: "the aardvark forages at night",
  });

  const bodyHit = (await ctx.query(api.pages.search, { term: "aardvark" }))[0];
  expect(bodyHit.snippet).toContain("aardvark");

  const titleHit = (await ctx.query(api.pages.search, { term: "Zoology" }))[0];
  expect(titleHit.snippet).toBeNull();
});

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

test("comments add / list / resolve (absolute) / remove", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });

  await ctx.mutation(api.comments.add, { pageId: id, text: "  fix this  " });
  let list = await ctx.query(api.comments.list, { pageId: id });
  expect(list).toHaveLength(1);
  expect(list[0].text).toBe("fix this"); // trimmed
  expect(list[0].resolved).toBeUndefined();

  const commentId = list[0]._id;
  await ctx.mutation(api.comments.setResolved, { id: commentId, value: true });
  // Absolute, so a replay doesn't flip it back.
  await ctx.mutation(api.comments.setResolved, { id: commentId, value: true });
  list = await ctx.query(api.comments.list, { pageId: id });
  expect(list[0].resolved).toBe(true);

  await ctx.mutation(api.comments.remove, { id: commentId });
  expect(await ctx.query(api.comments.list, { pageId: id })).toHaveLength(0);
});

test("comments ignore empty text and never bump the page's updatedAt", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Doc" });
  const before = (await ctx.query(api.pages.get, { id }))!.updatedAt;

  await ctx.mutation(api.comments.add, { pageId: id, text: "   " });
  expect(await ctx.query(api.comments.list, { pageId: id })).toHaveLength(0);

  await ctx.mutation(api.comments.add, { pageId: id, text: "real" });
  const after = (await ctx.query(api.pages.get, { id }))!.updatedAt;
  // A comment is not an edit — reconcile and LWW must not see one.
  expect(after).toBe(before);
});

test("deleteForever and emptyTrash cascade to comments", async () => {
  const ctx = t();
  const a = await ctx.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await ctx.mutation(api.pages.create, { type: "doc", title: "B" });
  await ctx.mutation(api.comments.add, { pageId: a, text: "on a" });
  await ctx.mutation(api.comments.add, { pageId: b, text: "on b" });

  await ctx.mutation(api.pages.trash, { id: a });
  await ctx.mutation(api.pages.deleteForever, { id: a });
  expect(await ctx.query(api.comments.list, { pageId: a })).toHaveLength(0);
  expect(await ctx.query(api.comments.list, { pageId: b })).toHaveLength(1);

  await ctx.mutation(api.pages.trash, { id: b });
  await ctx.mutation(api.pages.emptyTrash, {});
  expect(await ctx.query(api.comments.list, { pageId: b })).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* Computed + relation property types round-trip                       */
/* ------------------------------------------------------------------ */

test("rollup and timestamp property configs persist through updateDbProps", async () => {
  const ctx = t();
  const db = await ctx.mutation(api.pages.create, {
    type: "database",
    title: "Tasks",
  });
  await ctx.mutation(api.pages.updateDbProps, {
    id: db,
    dbProps: [
      { id: "rel", name: "Projects", type: "relation", targetId: "other" },
      {
        id: "roll",
        name: "Total",
        type: "rollup",
        relationPropId: "rel",
        rollupPropId: "budget",
        rollupCalc: "sum",
      },
      { id: "made", name: "Created", type: "createdTime" },
      { id: "edited", name: "Edited", type: "lastEditedTime" },
    ],
  });
  const doc = await ctx.query(api.pages.get, { id: db });
  expect(doc?.dbProps?.map((p) => p.type)).toEqual([
    "relation",
    "rollup",
    "createdTime",
    "lastEditedTime",
  ]);
  expect(doc?.dbProps?.[1].rollupCalc).toBe("sum");
});

/* ------------------------------------------------------------------ */
/* Deployment host rewrite (Phase-6 migration helper)                  */
/* ------------------------------------------------------------------ */

const OLD_HOST = "https://old-deployment-000.eu-west-1.convex.cloud";
const NEW_HOST = "https://new-deployment-111.eu-west-1.convex.cloud";

function imageDoc(url: string) {
  return [
    { id: "b1", type: "paragraph", content: [{ type: "text", text: "hi" }] },
    { id: "b2", type: "image", props: { url, caption: "" } },
  ];
}

test("rewriteHostBatch swaps the deployment host and bumps both timestamps", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Shot" });
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: imageDoc(`${OLD_HOST}/api/storage/abc123`),
    text: `see ${OLD_HOST}/api/storage/abc123`,
  });
  await ctx.mutation(api.pages.setCover, {
    id,
    cover: `${OLD_HOST}/api/storage/cover9`,
  });
  const before = (await ctx.query(api.pages.get, { id }))!;

  const res = await ctx.mutation(internal.migrate.rewriteHostBatch, {
    from: OLD_HOST,
    to: NEW_HOST,
    cursor: null,
  });
  expect(res.isDone).toBe(true);
  expect(res.rewritten).toBe(1);

  const after = (await ctx.query(api.pages.get, { id }))!;
  const json = JSON.stringify(after);
  expect(json).not.toContain(OLD_HOST);
  expect(after.cover).toBe(`${NEW_HOST}/api/storage/cover9`);
  expect((after.content as any)[1].props.url).toBe(
    `${NEW_HOST}/api/storage/abc123`,
  );
  // Derived text is swept too, or search would keep matching the old host.
  expect(after.contentText).toContain(NEW_HOST);
  expect(after.searchText).toContain(NEW_HOST);
  // Both bumped: updatedAt drives reconcile, contentUpdatedAt makes the
  // rewritten copy win LWW so replicas re-pull it.
  expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  expect(after.contentUpdatedAt!).toBeGreaterThanOrEqual(
    before.contentUpdatedAt!,
  );
});

test("rewriteHostBatch leaves untouched pages alone and paginates", async () => {
  const ctx = t();
  const clean = await ctx.mutation(api.pages.create, { type: "doc", title: "Clean" });
  await ctx.mutation(api.pages.updateContent, {
    id: clean,
    content: imageDoc("https://example.com/pic.png"),
    text: "nothing to see",
  });
  const dirty = await ctx.mutation(api.pages.create, { type: "doc", title: "Dirty" });
  await ctx.mutation(api.pages.setCover, { id: dirty, cover: `${OLD_HOST}/x` });
  const cleanBefore = (await ctx.query(api.pages.get, { id: clean }))!;

  let cursor: string | null = null;
  let rewritten = 0;
  let batches = 0;
  for (;;) {
    const res: any = await ctx.mutation(internal.migrate.rewriteHostBatch, {
      from: OLD_HOST,
      to: NEW_HOST,
      cursor,
      numItems: 1,
    });
    rewritten += res.rewritten;
    batches++;
    if (res.isDone) break;
    cursor = res.cursor;
    expect(batches).toBeLessThan(20); // cursor must actually advance
  }

  expect(rewritten).toBe(1);
  expect(batches).toBeGreaterThan(1);
  const cleanAfter = (await ctx.query(api.pages.get, { id: clean }))!;
  // Unmatched pages must not be touched — no timestamp churn, no re-pull.
  expect(cleanAfter.updatedAt).toBe(cleanBefore.updatedAt);
  expect(cleanAfter.contentUpdatedAt).toBe(cleanBefore.contentUpdatedAt);
});

test("rewriteVersionHostBatch sweeps history snapshots", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Hist" });
  // First write seeds content; the second snapshots it into pageVersions.
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: imageDoc(`${OLD_HOST}/api/storage/old1`),
    text: "v1",
  });
  await ctx.mutation(api.pages.updateContent, {
    id,
    content: imageDoc(`${OLD_HOST}/api/storage/old2`),
    text: "v2",
  });
  const versions = await ctx.query(api.versions.list, { pageId: id });
  expect(versions.length).toBeGreaterThan(0);

  const res = await ctx.mutation(internal.migrate.rewriteVersionHostBatch, {
    from: OLD_HOST,
    to: NEW_HOST,
    cursor: null,
  });
  expect(res.isDone).toBe(true);
  expect(res.rewritten).toBe(versions.length);

  for (const v of await ctx.query(api.versions.list, { pageId: id })) {
    const full = await ctx.query(api.versions.get, { id: v._id });
    expect(JSON.stringify(full)).not.toContain(OLD_HOST);
  }
});
