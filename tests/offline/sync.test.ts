/// <reference types="vite/client" />
// Integration tests: the real sync engine + outbox + store, wired to a
// convex-test backend through a transport with a controllable connection.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { PageDoc, PageId } from "../../src/lib/types";
import { createMemoryDb } from "../../src/offline/idb";
import { createOfflineMutations } from "../../src/offline/mutations";
import { isLocalId } from "../../src/offline/ops";
import { createOutbox } from "../../src/offline/outbox";
import { createPageStore } from "../../src/offline/store";
import {
  createSyncEngine,
  opToMutationCall,
  SyncTransport,
} from "../../src/offline/sync";

const modules = import.meta.glob([
  "../../convex/pages.ts",
  "../../convex/files.ts",
  "../../convex/schema.ts",
  "../../convex/lib/*.ts",
  "../../convex/_generated/*.js",
]);

// Functions require a signed-in user; bind the owner identity up front.
function makeBackend() {
  return convexTest(schema, modules).withIdentity({ subject: "owner|test" });
}

type Backend = ReturnType<typeof makeBackend>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeDevice(backend: Backend) {
  let connected = false;
  const connCbs = new Set<(c: boolean) => void>();
  const indexCbs = new Set<() => void>();
  const transport: SyncTransport = {
    fetchSyncIndex: () => backend.query(api.pages.syncIndex, {}),
    fetchDocs: (ids) =>
      backend.query(api.pages.getMany, {
        ids: ids as never,
      }) as unknown as Promise<PageDoc[]>,
    runMutation(op) {
      const [ref, args] = opToMutationCall(op);
      return backend.mutation(ref, args as never);
    },
    subscribeSyncIndex(cb) {
      indexCbs.add(cb);
      return () => indexCbs.delete(cb);
    },
    subscribeConnection(cb) {
      connCbs.add(cb);
      return () => connCbs.delete(cb);
    },
    isConnected: () => connected,
  };

  const db = createMemoryDb();
  const store = createPageStore();
  const outbox = await createOutbox(db);
  const engine = createSyncEngine({ db, store, outbox, transport });
  const mutations = createOfflineMutations({
    store,
    outbox: () => outbox,
    kick: () => engine.kick(),
    firstSyncDone: () => engine.firstSyncDone(),
  });
  await engine.start();

  return {
    db,
    store,
    outbox,
    engine,
    mutations,
    transport,
    setConnected(c: boolean) {
      connected = c;
      for (const cb of [...connCbs]) cb(c);
    },
    poke() {
      for (const cb of [...indexCbs]) cb();
    },
    async settle() {
      await engine.idle();
    },
  };
}

test("connect pulls existing server state into the replica", async () => {
  const backend = makeBackend();
  const id = await backend.mutation(api.pages.create, {
    type: "doc",
    title: "Server note",
  });
  const dev = await makeDevice(backend);
  expect(dev.store.size()).toBe(0);
  dev.setConnected(true);
  await dev.settle();
  expect(dev.store.get(id)?.title).toBe("Server note");
});

test("offline edits replay on reconnect and reach the server", async () => {
  const backend = makeBackend();
  const id = await backend.mutation(api.pages.create, {
    type: "doc",
    title: "Draft",
  });
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();

  dev.setConnected(false);
  await dev.mutations.updateContent({
    id,
    content: [{ type: "paragraph", text: "offline words" }],
    text: "offline words",
  });
  await dev.mutations.rename({ id, title: "Polished" });
  await dev.mutations.setIcon({ id, icon: "🔥" });
  expect(dev.outbox.size()).toBe(3);

  dev.setConnected(true);
  await dev.settle();
  expect(dev.outbox.size()).toBe(0);
  const doc = await backend.query(api.pages.get, { id });
  expect(doc?.title).toBe("Polished");
  expect(doc?.contentText).toBe("offline words");
  expect(doc?.icon).toBe("🔥");
});

test("offline-created tree syncs with id remapping (parent, child, pageLink)", async () => {
  const backend = makeBackend();
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle(); // first sync so we're a known-empty workspace

  dev.setConnected(false);
  const parentTemp = await dev.mutations.create({ type: "doc", title: "Parent" });
  const childTemp = await dev.mutations.create({
    type: "doc",
    title: "Child",
    parentId: parentTemp,
  });
  await dev.mutations.updateContent({
    id: parentTemp,
    content: [{ type: "pageLink", props: { pageId: childTemp } }],
    text: "",
  });
  expect(isLocalId(parentTemp)).toBe(true);

  dev.setConnected(true);
  await dev.settle();
  expect(dev.outbox.size()).toBe(0);

  // Replica holds only real ids now.
  const local = dev.store.all();
  expect(local).toHaveLength(2);
  expect(local.every((p) => !isLocalId(p._id))).toBe(true);

  // Server tree matches, including the rewritten pageLink.
  const pages = await backend.query(api.pages.list, {});
  expect(pages).toHaveLength(2);
  const parent = pages.find((p) => p.title === "Parent")!;
  const child = pages.find((p) => p.title === "Child")!;
  expect(child.parentId).toBe(parent._id);
  const parentDoc = await backend.query(api.pages.get, { id: parent._id });
  const blocks = parentDoc?.content as Array<{ props: { pageId: string } }>;
  expect(blocks[0].props.pageId).toBe(child._id);
});

test("two devices converge via LWW — newest content edit wins", async () => {
  const backend = makeBackend();
  const id = await backend.mutation(api.pages.create, {
    type: "doc",
    title: "Shared",
  });
  const devA = await makeDevice(backend);
  const devB = await makeDevice(backend);
  devA.setConnected(true);
  devB.setConnected(true);
  await devA.settle();
  await devB.settle();

  devA.setConnected(false);
  devB.setConnected(false);
  await devA.mutations.updateContent({
    id,
    content: [{ type: "paragraph", text: "older edit" }],
    text: "older edit",
  });
  await sleep(5);
  await devB.mutations.updateContent({
    id,
    content: [{ type: "paragraph", text: "newer edit" }],
    text: "newer edit",
  });

  // Newer edit lands first; the older replay must not clobber it.
  devB.setConnected(true);
  await devB.settle();
  devA.setConnected(true);
  await devA.settle();

  const doc = await backend.query(api.pages.get, { id });
  expect(doc?.contentText).toBe("newer edit");
  expect(devA.store.get(id)?.contentText).toBe("newer edit");
  devB.poke();
  await devB.settle();
  expect(devB.store.get(id)?.contentText).toBe("newer edit");
});

test("replaying a create after a crash does not duplicate the page", async () => {
  const backend = makeBackend();
  const dev1 = await makeDevice(backend);
  await dev1.mutations.create({ type: "doc", title: "Crashy" });
  const rawOp = structuredClone(dev1.outbox.peek()!.op);
  dev1.setConnected(true);
  await dev1.settle();
  expect(await backend.query(api.pages.list, {})).toHaveLength(1);

  // "Crash" left the same create op in another queue — replay it.
  const dev2 = await makeDevice(backend);
  dev2.outbox.enqueue(rawOp);
  dev2.setConnected(true);
  await dev2.settle();

  const pages = await backend.query(api.pages.list, {});
  expect(pages).toHaveLength(1);
  expect(dev2.store.size()).toBe(1);
  expect(dev2.store.all()[0]._id).toBe(pages[0]._id);
});

test("server-side deletions propagate to the replica", async () => {
  const backend = makeBackend();
  const id = await backend.mutation(api.pages.create, {
    type: "doc",
    title: "Doomed",
  });
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();
  expect(dev.store.get(id)).toBeTruthy();

  await backend.mutation(api.pages.trash, { id });
  await backend.mutation(api.pages.deleteForever, { id });
  dev.poke();
  await dev.settle();
  expect(dev.store.get(id)).toBeUndefined();
});

test("a page created and deleted offline never reaches the server", async () => {
  const backend = makeBackend();
  const dev = await makeDevice(backend);
  const temp = await dev.mutations.create({ type: "doc", title: "Ephemeral" });
  await dev.mutations.updateContent({
    id: temp,
    content: [],
    text: "scratch",
  });
  await dev.mutations.trash({ id: temp });
  await dev.mutations.deleteForever({ id: temp });
  expect(dev.outbox.size()).toBe(0);

  dev.setConnected(true);
  await dev.settle();
  expect(await backend.query(api.pages.syncIndex, {})).toHaveLength(0);
});

test("offline edit to a page deleted elsewhere is dropped cleanly", async () => {
  const backend = makeBackend();
  const id = await backend.mutation(api.pages.create, {
    type: "doc",
    title: "Racing",
  });
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();

  dev.setConnected(false);
  await dev.mutations.updateContent({ id, content: [], text: "too late" });
  await backend.mutation(api.pages.trash, { id });
  await backend.mutation(api.pages.deleteForever, { id });

  dev.setConnected(true);
  await dev.settle();
  expect(dev.outbox.size()).toBe(0);
  expect(dev.store.get(id)).toBeUndefined();
  expect(await backend.query(api.pages.syncIndex, {})).toHaveLength(0);
});

test("duplicating a server-pulled page syncs cleanly", async () => {
  const backend = makeBackend();
  const id = await backend.mutation(api.pages.create, {
    type: "doc",
    title: "Original",
  });
  // Give the server doc the sync-internal fields a pulled doc carries.
  await backend.mutation(api.pages.updateContent, {
    id,
    content: [{ type: "paragraph", text: "body" }],
    text: "body",
    clientUpdatedAt: Date.now(),
  });
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();

  const copyId = await dev.mutations.duplicate({ id });
  expect(copyId).not.toBeNull();
  await dev.settle();
  expect(dev.outbox.size()).toBe(0);
  const pages = await backend.query(api.pages.list, {});
  expect(pages.map((p) => p.title).sort()).toEqual([
    "Original",
    "Original (copy)",
  ]);
  // The copy is a real synced page locally, not a stranded temp doc.
  expect(dev.store.all().every((p) => !isLocalId(p._id))).toBe(true);
});

test("boot sweep clears a ghost temp page left by a crash after create-ack", async () => {
  const backend = makeBackend();
  const dev1 = await makeDevice(backend);
  const temp = await dev1.mutations.create({ type: "doc", title: "Crashish" });
  dev1.setConnected(true);
  await dev1.settle();
  const realId = (await backend.query(api.pages.list, {}))[0]._id;

  // Simulate the crash window: idMap persisted, but the replica on disk
  // still holds the doc under its temp id.
  const db2 = createMemoryDb();
  await db2.setMeta("idMap", { [temp]: realId });
  await db2.setMeta("hasEverSynced", true);
  const ghost = structuredClone(dev1.store.get(realId as PageId))!;
  ghost._id = temp;
  await db2.putPages([ghost]);

  const store2 = createPageStore();
  const outbox2 = await createOutbox(db2);
  const dev2Transport = await makeDevice(backend); // reuse helper's transport shape
  const engine2 = createSyncEngine({
    db: db2,
    store: store2,
    outbox: outbox2,
    transport: dev2Transport.transport,
  });
  await engine2.start();
  // The sweep remapped the ghost before any network activity.
  expect(store2.get(temp as PageId)).toBeUndefined();
  expect(store2.get(realId as PageId)?.title).toBe("Crashish");

  dev2Transport.setConnected(true);
  await engine2.idle();
  expect(store2.all()).toHaveLength(1);
  expect(await backend.query(api.pages.list, {})).toHaveLength(1);
});

test("bootstrap waits for first sync, then seeds an empty workspace once", async () => {
  const backend = makeBackend();
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();

  const welcome = await dev.mutations.bootstrap();
  expect(welcome).not.toBeNull();
  await dev.settle();
  const pages = await backend.query(api.pages.list, {});
  expect(pages).toHaveLength(1);
  expect(pages[0].title).toBe("Welcome to Vellum");

  // A second device syncing the same workspace must not seed again.
  const dev2 = await makeDevice(backend);
  dev2.setConnected(true);
  await dev2.settle();
  expect(await dev2.mutations.bootstrap()).toBeNull();
  expect(await backend.query(api.pages.list, {})).toHaveLength(1);
});

test("offline-created relations resolve to real ids on both sides", async () => {
  const backend = makeBackend();
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();

  // Build two databases, a row in each, and a relation between them — all
  // while offline, so every id involved is a temp id.
  dev.setConnected(false);
  const projects = await dev.mutations.create({
    type: "database",
    title: "Projects",
  });
  const tasks = await dev.mutations.create({ type: "database", title: "Tasks" });
  const projectRow = await dev.mutations.create({
    type: "doc",
    title: "Apollo",
    parentId: projects,
  });
  const taskRow = await dev.mutations.create({
    type: "doc",
    title: "Ship it",
    parentId: tasks,
  });
  await dev.mutations.updateDbProps({
    id: tasks,
    dbProps: [
      { id: "proj", name: "Project", type: "relation", targetId: projects },
    ],
  });
  await dev.mutations.setRowProp({
    id: taskRow,
    propId: "proj",
    value: [projectRow],
  });
  expect(isLocalId(projects)).toBe(true);
  expect(isLocalId(projectRow)).toBe(true);

  dev.setConnected(true);
  await dev.settle();
  await dev.settle();

  // Server side: no temp ids survived.
  const serverPages = await backend.query(api.pages.list, {});
  const serverTasks = serverPages.find((p) => p.title === "Tasks")!;
  const serverProjects = serverPages.find((p) => p.title === "Projects")!;
  const serverProjectRow = serverPages.find((p) => p.title === "Apollo")!;
  const serverTaskRow = serverPages.find((p) => p.title === "Ship it")!;
  const tasksDoc = await backend.query(api.pages.get, { id: serverTasks._id });
  expect(tasksDoc?.dbProps?.[0].targetId).toBe(serverProjects._id);
  expect(serverTaskRow.props?.proj).toEqual([serverProjectRow._id]);

  // Replica side: remapId rewrote the relation value and targetId too, so
  // the local chips point at the real rows rather than dead temp ids.
  const localTasks = dev.store.get(serverTasks._id)!;
  expect(localTasks.dbProps?.[0].targetId).toBe(serverProjects._id);
  const localTaskRow = dev.store.get(serverTaskRow._id)!;
  expect(localTaskRow.props?.proj).toEqual([serverProjectRow._id]);
  expect(dev.store.all().some((p) => isLocalId(p._id))).toBe(false);
});

test("offline template flag and instantiation replay to the server", async () => {
  const backend = makeBackend();
  const dev = await makeDevice(backend);
  dev.setConnected(true);
  await dev.settle();

  dev.setConnected(false);
  const tpl = await dev.mutations.create({ type: "doc", title: "Weekly" });
  await dev.mutations.setTemplate({ id: tpl, value: true });
  const instance = (await dev.mutations.duplicate({
    id: tpl,
    toRoot: true,
    suffix: "",
    asInstance: true,
  }))!;
  expect(dev.store.get(instance)?.isTemplate).toBeUndefined();

  dev.setConnected(true);
  await dev.settle();
  await dev.settle();

  const pages = await backend.query(api.pages.list, {});
  expect(pages.filter((p) => p.title === "Weekly")).toHaveLength(2);
  expect(pages.filter((p) => p.isTemplate)).toHaveLength(1);
});
