import { expect, test } from "vitest";
import { createPageStore } from "../../src/offline/store";
import { PageId } from "../../src/lib/types";

const pid = (s: string) => s as PageId;

test("create / rename / list projections", () => {
  const store = createPageStore();
  const a = store.create({ type: "doc", title: "A" }, pid("p1"), 100);
  expect(a.rank).toBe(1024);
  const b = store.create({ type: "doc", parentId: pid("p1") }, pid("p2"), 101);
  expect(b.parentId).toBe("p1");
  store.rename(pid("p2"), "Child", 102);
  expect(store.get(pid("p2"))?.title).toBe("Child");
  expect(store.get(pid("p2"))?.updatedAt).toBe(102);
  expect(store.all()).toHaveLength(2);
});

test("database creation gets default props and view", () => {
  const store = createPageStore();
  const db = store.create({ type: "database", title: "Tasks" }, pid("d1"), 100);
  expect(db.dbProps?.map((p) => p.id)).toEqual(["status", "tags", "date"]);
  expect(db.activeView).toBe("table");
});

test("trash marks subtree, restore brings it back, favorites cleared", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "A" }, pid("a"), 1);
  store.create({ type: "doc", title: "B", parentId: pid("a") }, pid("b"), 2);
  store.toggleFavorite(pid("a"), 3);
  const trashed = store.trash(pid("a"), 10);
  expect(trashed.sort()).toEqual(["a", "b"]);
  expect(store.get(pid("a"))?.trashRoot).toBe(true);
  expect(store.get(pid("b"))?.trashRoot).toBe(false);
  expect(store.get(pid("a"))?.isFavorite).toBe(false);
  store.restore(pid("a"), 20);
  expect(store.get(pid("a"))?.inTrash).toBeUndefined();
  expect(store.get(pid("b"))?.inTrash).toBeUndefined();
  expect(store.get(pid("b"))?.parentId).toBe("a");
});

test("restoring a child of a trashed parent moves it to root", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "A" }, pid("a"), 1);
  store.create({ type: "doc", title: "B", parentId: pid("a") }, pid("b"), 2);
  store.trash(pid("b"), 10);
  store.trash(pid("a"), 11);
  store.restore(pid("b"), 20);
  expect(store.get(pid("b"))?.parentId).toBeUndefined();
});

test("move refuses cycles", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "A" }, pid("a"), 1);
  store.create({ type: "doc", title: "B", parentId: pid("a") }, pid("b"), 2);
  expect(store.move(pid("a"), pid("b"), 1, 10)).toBe(false);
  expect(store.get(pid("a"))?.parentId).toBeUndefined();
  expect(store.move(pid("b"), undefined, 99, 10)).toBe(true);
  expect(store.get(pid("b"))?.parentId).toBeUndefined();
});

test("duplicate clones subtree and reports every created doc", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "Notes" }, pid("a"), 1);
  store.create({ type: "doc", title: "Inner", parentId: pid("a") }, pid("b"), 2);
  let n = 0;
  const result = store.duplicate(pid("a"), () => pid(`copy${n++}`), 50)!;
  expect(result.created).toHaveLength(2);
  expect(result.rootId).toBe("copy0");
  expect(store.get(pid("copy0"))?.title).toBe("Notes (copy)");
  expect(store.get(pid("copy1"))?.parentId).toBe("copy0");
  // Root duplicated before children — replay order for the outbox.
  expect(result.created[0]._id).toBe("copy0");
});

test("deleteForever removes subtree; emptyTrash removes all trashed", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "A" }, pid("a"), 1);
  store.create({ type: "doc", title: "B", parentId: pid("a") }, pid("b"), 2);
  store.create({ type: "doc", title: "C" }, pid("c"), 3);
  expect(store.deleteForever(pid("a")).sort()).toEqual(["a", "b"]);
  expect(store.all()).toHaveLength(1);
  store.trash(pid("c"), 10);
  expect(store.emptyTrash()).toEqual(["c"]);
  expect(store.size()).toBe(0);
});

test("remapId rewrites the doc, child parentIds, and pageLink blocks", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "Parent" }, pid("local_p"), 1);
  store.create(
    { type: "doc", title: "Child", parentId: pid("local_p") },
    pid("local_c"),
    2,
  );
  store.updateContent(
    pid("local_p"),
    [
      {
        type: "pageLink",
        props: { pageId: "local_c" },
        children: [{ type: "pageLink", props: { pageId: "local_c" } }],
      },
    ],
    "",
    3,
  );
  store.remapId(pid("local_p"), pid("real_p"));
  expect(store.get(pid("local_p"))).toBeUndefined();
  expect(store.get(pid("real_p"))?.title).toBe("Parent");
  expect(store.get(pid("local_c"))?.parentId).toBe("real_p");
  store.remapId(pid("local_c"), pid("real_c"));
  const content = store.get(pid("real_p"))?.content as Array<{
    props: { pageId: string };
    children: Array<{ props: { pageId: string } }>;
  }>;
  expect(content[0].props.pageId).toBe("real_c");
  expect(content[0].children[0].props.pageId).toBe("real_c");
});

test("bootstrap only seeds an empty store", () => {
  const store = createPageStore();
  expect(store.bootstrap(pid("w"), 1)?.title).toBe("Welcome to Vellum");
  expect(store.bootstrap(pid("w2"), 2)).toBeNull();
});

test("commit hook reports changed and removed ids", () => {
  const store = createPageStore();
  const events: Array<{ changed: string[]; removed: string[] }> = [];
  store.setOnCommit((changed, removed) => events.push({ changed, removed }));
  store.create({ type: "doc", title: "A" }, pid("a"), 1);
  store.deleteForever(pid("a"));
  expect(events).toEqual([
    { changed: ["a"], removed: [] },
    { changed: [], removed: ["a"] },
  ]);
});

test("setTemplate is absolute, not a toggle", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "T" }, pid("t"), 1);
  expect(store.get(pid("t"))?.isTemplate).toBeUndefined();
  store.setTemplate(pid("t"), true, 2);
  expect(store.get(pid("t"))?.isTemplate).toBe(true);
  expect(store.get(pid("t"))?.updatedAt).toBe(2);
  // Replaying the same value must not flip it.
  store.setTemplate(pid("t"), true, 3);
  expect(store.get(pid("t"))?.isTemplate).toBe(true);
  store.setTemplate(pid("t"), false, 4);
  expect(store.get(pid("t"))?.isTemplate).toBe(false);
  expect(store.setTemplate(pid("missing"), true, 5)).toBeUndefined();
});

test("duplicate asInstance clears the template flag, drops suffix, reparents", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "Weekly" }, pid("tpl"), 1);
  store.create({ type: "doc", title: "Agenda", parentId: pid("tpl") }, pid("kid"), 2);
  store.setTemplate(pid("tpl"), true, 3);
  store.create({ type: "doc", title: "Home" }, pid("home"), 4);

  let n = 0;
  const result = store.duplicate(pid("tpl"), () => pid(`new${n++}`), 10, {
    parentId: pid("home"),
    suffix: "",
    asInstance: true,
  })!;
  const root = store.get(result.rootId)!;
  expect(root.title).toBe("Weekly");
  expect(root.isTemplate).toBeUndefined();
  expect(root.parentId).toBe("home");
  // Rank comes from the destination parent, not the source's neighbours.
  expect(root.rank).toBe(1024);
  expect(result.created).toHaveLength(2);
  // The nested copy keeps its template-less status and hangs off the copy.
  expect(result.created[1].parentId).toBe(result.rootId);
  // The source template is untouched.
  expect(store.get(pid("tpl"))?.isTemplate).toBe(true);
});

test("duplicate without options still copies alongside with ' (copy)'", () => {
  const store = createPageStore();
  store.create({ type: "doc", title: "Notes" }, pid("n"), 1);
  let n = 0;
  const result = store.duplicate(pid("n"), () => pid(`c${n++}`), 5)!;
  const copy = store.get(result.rootId)!;
  expect(copy.title).toBe("Notes (copy)");
  expect(copy.parentId).toBeUndefined();
});

test("remapId rewrites relation prop values and dbProps.targetId", () => {
  const store = createPageStore();
  // A database whose relation column targets a page created offline.
  store.create({ type: "database", title: "Tasks" }, pid("db"), 1);
  store.updateDbProps(
    pid("db"),
    [{ id: "proj", name: "Project", type: "relation", targetId: "local_projects" }],
    2,
  );
  // A row linking to two offline-created rows (one of them being remapped).
  store.create({ type: "doc", title: "Row", parentId: pid("db") }, pid("row"), 3);
  store.setRowProp(pid("row"), "proj", ["local_projects", "other"], 4);
  // The page being remapped itself.
  store.create({ type: "doc", title: "Projects" }, pid("local_projects"), 5);

  store.remapId(pid("local_projects"), pid("real_projects"));

  expect(store.get(pid("local_projects"))).toBeUndefined();
  expect(store.get(pid("real_projects"))?.title).toBe("Projects");
  expect(store.get(pid("db"))?.dbProps?.[0].targetId).toBe("real_projects");
  expect(store.get(pid("row"))?.props?.proj).toEqual(["real_projects", "other"]);
});
