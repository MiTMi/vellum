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
