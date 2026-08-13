import { expect, test } from "vitest";
import { createMemoryDb } from "../../src/offline/idb";
import { createOutbox } from "../../src/offline/outbox";
import { OutboxOp } from "../../src/offline/ops";

const edit = (id: string, text: string, at: number): OutboxOp => ({
  kind: "updateContent",
  id,
  content: [{ type: "paragraph", text }],
  text,
  clientUpdatedAt: at,
});

test("consecutive edits to the same page coalesce to the latest", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue(edit("a", "one", 1));
  outbox.enqueue(edit("a", "two", 2));
  outbox.enqueue(edit("a", "three", 3));
  expect(outbox.size()).toBe(1);
  const op = outbox.peek()!.op;
  expect(op.kind === "updateContent" && op.text).toBe("three");
});

test("edits to different pages do not coalesce; FIFO order holds", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue(edit("a", "one", 1));
  outbox.enqueue(edit("b", "two", 2));
  outbox.enqueue(edit("a", "three", 3));
  // a's second edit merged into a's slot, order preserved: [a, b]
  expect(outbox.list().map((o) => (o.op.kind === "updateContent" ? o.op.id : ""))).toEqual(["a", "b"]);
  expect(outbox.size()).toBe(2);
});

test("order-sensitive ops never coalesce", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "trash", id: "a" });
  outbox.enqueue({ kind: "restore", id: "a" });
  outbox.enqueue({ kind: "trash", id: "a" });
  expect(outbox.size()).toBe(3);
});

test("setPageOptions merges fields across enqueues", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "setPageOptions", id: "a", locked: true });
  outbox.enqueue({ kind: "setPageOptions", id: "a", fullWidth: true });
  expect(outbox.size()).toBe(1);
  const op = outbox.peek()!.op;
  expect(op).toMatchObject({ locked: true, fullWidth: true });
});

test("setRowProp coalesces per property, not per page", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "setRowProp", id: "a", propId: "status", value: "todo" });
  outbox.enqueue({ kind: "setRowProp", id: "a", propId: "date", value: "2026-01-01" });
  outbox.enqueue({ kind: "setRowProp", id: "a", propId: "status", value: "done" });
  expect(outbox.size()).toBe(2);
  const status = outbox
    .list()
    .find((o) => o.op.kind === "setRowProp" && o.op.propId === "status")!;
  expect(status.op).toMatchObject({ value: "done" });
});

test("queue survives a restart via the db", async () => {
  const db = createMemoryDb();
  const outbox = await createOutbox(db);
  outbox.enqueue(edit("a", "one", 1));
  outbox.enqueue(edit("a", "two", 2)); // coalesces into first slot
  outbox.enqueue({ kind: "trash", id: "b" });
  outbox.enqueue(edit("a", "three", 3)); // behind the barrier — new op
  await outbox.flushed();

  const reloaded = await createOutbox(db);
  expect(reloaded.size()).toBe(3);
  expect(reloaded.list().map((o) => o.op.kind)).toEqual([
    "updateContent",
    "trash",
    "updateContent",
  ]);
  const first = reloaded.peek()!;
  expect(first.op).toMatchObject({ text: "two" });

  reloaded.complete(first.seq);
  await reloaded.flushed();
  const again = await createOutbox(db);
  expect(again.list().map((o) => o.op.kind)).toEqual(["trash", "updateContent"]);
});

test("dropOpsForUnsyncedCreate removes a queued create and its ops", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({
    kind: "createWithDoc",
    clientKey: "local_x",
    doc: { title: "T", type: "doc", rank: 1024, updatedAt: 1 },
  });
  outbox.enqueue(edit("local_x", "hello", 2));
  outbox.enqueue(edit("other", "keep", 3));
  expect(outbox.dropOpsForUnsyncedCreate("local_x")).toBe(true);
  expect(outbox.size()).toBe(1);
  expect(outbox.peek()!.op).toMatchObject({ id: "other" });
  // No queued create for this key → caller must send a server delete.
  expect(outbox.dropOpsForUnsyncedCreate("local_x")).toBe(false);
});

test("an in-flight op is never coalesced into", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue(edit("a", "sent", 1));
  const head = outbox.peek()!;
  outbox.markInFlight(head.seq);
  // Typed while the op is on the wire — must become a NEW op, or it would
  // be deleted unsent when the in-flight op acks.
  outbox.enqueue(edit("a", "typed during rtt", 2));
  expect(outbox.size()).toBe(2);
  outbox.complete(head.seq);
  outbox.clearInFlight();
  expect(outbox.peek()!.op).toMatchObject({ text: "typed during rtt" });
});

test("coalescing never crosses an order-sensitive barrier", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "move", id: "x", rank: 1 });
  outbox.enqueue({
    kind: "createWithDoc",
    clientKey: "local_b",
    doc: { title: "B", type: "doc", rank: 1024, updatedAt: 1 },
  });
  // Moving x into the just-created page must NOT merge into the earlier
  // move op — that would replay it before local_b exists.
  outbox.enqueue({ kind: "move", id: "x", parentId: "local_b", rank: 2 });
  expect(outbox.size()).toBe(3);
  expect(outbox.list().map((o) => o.op.kind)).toEqual([
    "move",
    "createWithDoc",
    "move",
  ]);
});

test("dropOpsForUnsyncedCreate refuses while the create is in flight", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({
    kind: "createWithDoc",
    clientKey: "local_x",
    doc: { title: "T", type: "doc", rank: 1024, updatedAt: 1 },
  });
  outbox.markInFlight(outbox.peek()!.seq);
  // The server may already have applied it — caller must delete for real.
  expect(outbox.dropOpsForUnsyncedCreate("local_x")).toBe(false);
  outbox.clearInFlight();
  expect(outbox.dropOpsForUnsyncedCreate("local_x")).toBe(true);
});

test("touchedIds covers ids and clientKeys of queued ops", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({
    kind: "createWithDoc",
    clientKey: "local_x",
    doc: { title: "T", type: "doc", rank: 1024, updatedAt: 1 },
  });
  outbox.enqueue(edit("a", "x", 1));
  outbox.enqueue({ kind: "emptyTrash" });
  expect([...outbox.touchedIds()].sort()).toEqual(["a", "local_x"]);
});

test("setTemplate ops coalesce to the last absolute value", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "setTemplate", id: "a", value: true });
  outbox.enqueue({ kind: "setTemplate", id: "a", value: false });
  outbox.enqueue({ kind: "setTemplate", id: "a", value: true });
  expect(outbox.size()).toBe(1);
  const op = outbox.peek()!.op;
  expect(op.kind === "setTemplate" && op.value).toBe(true);
});

test("setTemplate does not coalesce across an order-sensitive op", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "setTemplate", id: "a", value: true });
  outbox.enqueue({ kind: "trash", id: "b" });
  outbox.enqueue({ kind: "setTemplate", id: "a", value: false });
  expect(outbox.list().map((o) => o.op.kind)).toEqual([
    "setTemplate",
    "trash",
    "setTemplate",
  ]);
});

test("a rename never coalesces back past an edit to the same page", async () => {
  // rename and updateContent have different coalesce keys but share one
  // server-side clock (contentUpdatedAt). Merging the newer rename into the
  // earlier rename's slot would replay [rename@3, content@2] — the server
  // stamps 3, then drops the content op as stale and returns success. The
  // outbox deletes it, local updatedAt is already 3 so reconcile sees no
  // difference, and the typed text exists on that one device only.
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "rename", id: "a", title: "First", clientUpdatedAt: 1 });
  outbox.enqueue(edit("a", "body", 2));
  outbox.enqueue({ kind: "rename", id: "a", title: "Second", clientUpdatedAt: 3 });

  const kinds = outbox.list().map((o) => o.op.kind);
  expect(kinds).toEqual(["rename", "updateContent", "rename"]);
  // Timestamps only ever increase down the queue — that is the invariant
  // the server's last-writer-wins guard depends on.
  const stamps = outbox
    .list()
    .map((o) => (o.op as { clientUpdatedAt?: number }).clientUpdatedAt!);
  expect(stamps).toEqual([...stamps].sort((x, y) => x - y));
});

test("edits still coalesce across an unstamped op on the same page", async () => {
  // The barrier is only about the shared clock. setIcon carries no stamp,
  // so it must not cost the queue its coalescing.
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue(edit("a", "one", 1));
  outbox.enqueue({ kind: "setIcon", id: "a", icon: "🔥" });
  outbox.enqueue(edit("a", "two", 2));
  expect(outbox.size()).toBe(2);
  const first = outbox.peek()!.op;
  expect(first.kind === "updateContent" && first.text).toBe("two");
});

test("a rename coalesces past ops on a different page", async () => {
  const outbox = await createOutbox(createMemoryDb());
  outbox.enqueue({ kind: "rename", id: "a", title: "First", clientUpdatedAt: 1 });
  outbox.enqueue(edit("b", "elsewhere", 2));
  outbox.enqueue({ kind: "rename", id: "a", title: "Second", clientUpdatedAt: 3 });
  expect(outbox.size()).toBe(2);
  const first = outbox.peek()!.op;
  expect(first.kind === "rename" && first.title).toBe("Second");
});

test("two tabs sharing one store neither lose nor delete each other's ops", async () => {
  // The outbox is one IndexedDB store per origin, but each tab counts its
  // own seq from what it loaded. They used to land on the same number:
  // one tab's add() failed with a ConstraintError that mirror() swallowed
  // into a console.error (that op silently never persisted), and either
  // tab's complete() deleted the other's row.
  const db = createMemoryDb();
  const tabA = await createOutbox(db);
  const tabB = await createOutbox(db);

  tabA.enqueue(edit("a", "from tab A", 1));
  tabB.enqueue(edit("b", "from tab B", 2));
  await tabA.flushed();
  await tabB.flushed();

  // Both survived — a fresh tab (i.e. a reload) sees the whole queue.
  const persisted = await db.loadOps();
  expect(persisted).toHaveLength(2);
  expect(
    persisted.map((o) => (o.op.kind === "updateContent" ? o.op.text : "")).sort(),
  ).toEqual(["from tab A", "from tab B"]);

  // Tab A replaying its own op must not remove tab B's.
  tabA.complete(tabA.peek()!.seq);
  await tabA.flushed();
  const left = await db.loadOps();
  expect(left).toHaveLength(1);
  expect(left[0].op.kind === "updateContent" && left[0].op.text).toBe(
    "from tab B",
  );
});
