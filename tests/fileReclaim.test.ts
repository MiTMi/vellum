/// <reference types="vite/client" />
/**
 * Storage reclamation, end to end.
 *
 * The promise being tested: when a user deletes something, the bytes go
 * too — nothing keeps consuming Convex storage. Before this, deleting a
 * page dropped its rows and left every image behind forever (two such
 * orphans were found on production, 2026-08-12).
 *
 * Both directions matter and both are covered:
 *   - an orphaned blob IS deleted (the feature)
 *   - a still-referenced blob is NEVER deleted (the way this breaks data)
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { addUser, ownerBackend, TestAccessor, TestConvex } from "./helpers";

/* ----------------------------- harness ----------------------------- */

/** Put real bytes in storage and register them the way an upload does. */
async function upload(
  tc: TestConvex,
  as: TestAccessor,
  body = "image-bytes",
): Promise<{ storageId: Id<"_storage">; url: string }> {
  const storageId = await tc.run(async (ctx) =>
    ctx.storage.store(new Blob([body], { type: "image/webp" })),
  );
  const { url } = await as.mutation(api.files.getFileUrl, { storageId });
  expect(url).toBeTruthy();
  return { storageId, url: url! };
}

/** Bytes actually held by the backend, which is the whole question. */
async function storedObjects(tc: TestConvex): Promise<number> {
  return await tc.run(
    async (ctx) => (await ctx.db.system.query("_storage").collect()).length,
  );
}

async function fileRows(tc: TestConvex): Promise<number> {
  return await tc.run(
    async (ctx) => (await ctx.db.query("files").collect()).length,
  );
}

const imageBlock = (url: string) => [
  { type: "image", props: { url, caption: "" }, content: [] },
];

/** Let every scheduled reclaim (and anything it schedules) finish. */
async function settle(tc: TestConvex): Promise<void> {
  await tc.finishAllScheduledFunctions(vi.runAllTimers);
}

/**
 * Move the (faked) clock forward so a just-stored blob is genuinely older
 * than the sweep's cutoff. Without this every object's `_creationTime`
 * equals a frozen `Date.now()`, and even `graceMs: 0` reads it as still
 * inside its grace window — which is correct behaviour, just untestable
 * at zero elapsed time.
 */
function ageClock(ms = 1000): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/* -------------------------- the core promise ------------------------ */

test("deleting a page forever reclaims the image it embedded", async () => {
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Trip" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, {
    id: page,
    content: imageBlock(url),
    text: "",
  });

  expect(await storedObjects(tc)).toBe(1);

  await as.mutation(api.pages.trash, { id: page });
  await as.mutation(api.pages.deleteForever, { id: page });
  await settle(tc);

  expect(await storedObjects(tc)).toBe(0);
  expect(await fileRows(tc)).toBe(0);
});

test("emptying the trash reclaims images from every page in it", async () => {
  const { tc, as } = await ownerBackend();
  const a = await as.mutation(api.pages.create, { type: "doc", title: "A" });
  const b = await as.mutation(api.pages.create, { type: "doc", title: "B" });
  const one = await upload(tc, as, "one");
  const two = await upload(tc, as, "two");
  await as.mutation(api.pages.updateContent, { id: a, content: imageBlock(one.url), text: "" });
  await as.mutation(api.pages.updateContent, { id: b, content: imageBlock(two.url), text: "" });
  expect(await storedObjects(tc)).toBe(2);

  await as.mutation(api.pages.trash, { id: a });
  await as.mutation(api.pages.trash, { id: b });
  await as.mutation(api.pages.emptyTrash, {});
  await settle(tc);

  expect(await storedObjects(tc)).toBe(0);
});

test("a cover image is reclaimed too, not just content", async () => {
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Covered" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.setCover, { id: page, cover: url });

  await as.mutation(api.pages.trash, { id: page });
  await as.mutation(api.pages.deleteForever, { id: page });
  await settle(tc);

  expect(await storedObjects(tc)).toBe(0);
});

test("a child page's image is reclaimed when the parent is deleted", async () => {
  const { tc, as } = await ownerBackend();
  const parent = await as.mutation(api.pages.create, { type: "doc", title: "Parent" });
  const child = await as.mutation(api.pages.create, {
    type: "doc",
    title: "Child",
    parentId: parent,
  });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, { id: child, content: imageBlock(url), text: "" });

  await as.mutation(api.pages.trash, { id: parent });
  await as.mutation(api.pages.deleteForever, { id: parent });
  await settle(tc);

  expect(await storedObjects(tc)).toBe(0);
});

/* ------------------- the way this destroys user data ---------------- */

test("a blob shared by a duplicated page survives until BOTH are gone", async () => {
  // `duplicate` copies content verbatim, so two pages point at one blob.
  // This is the case that makes naive delete-on-page-delete wrong.
  const { tc, as } = await ownerBackend();
  const original = await as.mutation(api.pages.create, { type: "doc", title: "Orig" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, { id: original, content: imageBlock(url), text: "" });

  const copy = await as.mutation(api.pages.duplicate, { id: original });
  expect(copy).not.toBeNull();

  await as.mutation(api.pages.trash, { id: original });
  await as.mutation(api.pages.deleteForever, { id: original });
  await settle(tc);
  // The copy still shows that image — deleting it here would be data loss.
  expect(await storedObjects(tc)).toBe(1);

  await as.mutation(api.pages.trash, { id: copy as Id<"pages"> });
  await as.mutation(api.pages.deleteForever, { id: copy as Id<"pages"> });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
});

test("a blob still referenced by page history is not reclaimed", async () => {
  // The image was removed from the page, but a version snapshot still holds
  // it — restoring that version has to keep working.
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Edited" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, { id: page, content: imageBlock(url), text: "" });
  // A later edit drops the image; updateContent snapshots the previous content.
  await as.mutation(api.pages.updateContent, {
    id: page,
    content: [{ type: "paragraph", content: [] }],
    text: "",
  });
  const versions = await tc.run(
    async (ctx) => (await ctx.db.query("pageVersions").collect()).length,
  );
  expect(versions).toBeGreaterThan(0);

  // Age past the grace window first, so the sweep really reaches the
  // reference check rather than skipping the blob as "too new".
  ageClock();
  const pass = await tc.mutation(internal.files._sweep, { graceMs: 0 });
  expect(pass.scanned).toBe(1);
  expect(pass.deleted).toBe(0);
  expect(await storedObjects(tc)).toBe(1);

  // Deleting the page takes the history with it — now it's free.
  await as.mutation(api.pages.trash, { id: page });
  await as.mutation(api.pages.deleteForever, { id: page });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
});

test("the sweep never touches a blob a live page references", async () => {
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Keep" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, { id: page, content: imageBlock(url), text: "" });

  // Past the grace window, so "kept" is a decision about references and
  // not merely about age — this is the assertion that stops the sweep from
  // eating live images.
  ageClock();
  const result = await tc.mutation(internal.files._sweep, { graceMs: 0 });
  expect(result.scanned).toBe(1);
  expect(result.deleted).toBe(0);
  expect(await storedObjects(tc)).toBe(1);
});

test("one user's deletion cannot reclaim another user's file", async () => {
  const { tc, as: owner } = await ownerBackend();
  const { as: friend } = await addUser(tc, "friend@vellum.test");

  const mine = await owner.mutation(api.pages.create, { type: "doc", title: "Mine" });
  const theirs = await friend.mutation(api.pages.create, { type: "doc", title: "Theirs" });
  const a = await upload(tc, owner, "mine");
  const b = await upload(tc, friend, "theirs");
  await owner.mutation(api.pages.updateContent, { id: mine, content: imageBlock(a.url), text: "" });
  await friend.mutation(api.pages.updateContent, { id: theirs, content: imageBlock(b.url), text: "" });
  expect(await storedObjects(tc)).toBe(2);

  await owner.mutation(api.pages.trash, { id: mine });
  await owner.mutation(api.pages.deleteForever, { id: mine });
  await settle(tc);

  // Exactly one gone, and it's the right one.
  expect(await storedObjects(tc)).toBe(1);
  const survivor = await tc.run(async (ctx) => {
    const rows = await ctx.db.system.query("_storage").collect();
    return await ctx.storage.getUrl(rows[0]._id);
  });
  expect(survivor).toBe(b.url);
});

/* ------------------------- the global sweep ------------------------- */

test("an abandoned upload is swept once it is past the grace period", async () => {
  // Uploaded, registered, but no page ever referenced it — the shape of the
  // two orphans found on production.
  const { tc, as } = await ownerBackend();
  await upload(tc, as, "abandoned");
  expect(await storedObjects(tc)).toBe(1);

  // Inside the grace window it is protected: a just-uploaded file has no
  // referrer yet, and reaping it would break the save that's about to land.
  const guarded = await tc.mutation(internal.files._sweep, {});
  expect(guarded.deleted).toBe(0);
  expect(await storedObjects(tc)).toBe(1);

  ageClock();
  const swept = await tc.mutation(internal.files._sweep, { graceMs: 0 });
  expect(swept.deleted).toBe(1);
  expect(await storedObjects(tc)).toBe(0);
  expect(await fileRows(tc)).toBe(0);
});

test("the sweep reclaims blobs that predate the files table", async () => {
  // Stored with no `files` row at all — exactly the legacy orphans that
  // usageOverview reported as 0 MB while they sat on the server.
  const { tc } = await ownerBackend();
  await tc.run(async (ctx) => {
    await ctx.storage.store(new Blob(["legacy"], { type: "image/png" }));
  });
  expect(await storedObjects(tc)).toBe(1);
  expect(await fileRows(tc)).toBe(0);

  ageClock();
  const swept = await tc.mutation(internal.files._sweep, { graceMs: 0 });
  expect(swept.deleted).toBe(1);
  expect(await storedObjects(tc)).toBe(0);
});

test("dryRun reports what it would remove without removing it", async () => {
  const { tc, as } = await ownerBackend();
  await upload(tc, as, "orphan");
  ageClock();
  const report = await tc.mutation(internal.files._sweep, {
    graceMs: 0,
    dryRun: true,
  });
  expect(report.deleted).toBe(1);
  expect(report.bytes).toBeGreaterThan(0);
  expect(await storedObjects(tc)).toBe(1); // still there
});

test("a backlog larger than one pass finishes without waiting for tomorrow", async () => {
  // One pass is capped to stay inside a mutation's limits. If it stopped
  // there, clearing a real backlog would take one nightly cron per 200
  // files — so a full pass continues itself.
  const { tc } = await ownerBackend();
  const BACKLOG = 250; // > MAX_DELETES_PER_PASS (200)
  await tc.run(async (ctx) => {
    for (let i = 0; i < BACKLOG; i++) {
      await ctx.storage.store(new Blob([`orphan-${i}`], { type: "image/png" }));
    }
  });
  expect(await storedObjects(tc)).toBe(BACKLOG);

  ageClock();
  const first = await tc.mutation(internal.files._sweep, { graceMs: 0 });
  expect(first.deleted).toBe(200);
  expect(first.done).toBe(false);
  expect(first.continued).toBe(true); // scheduled its own continuation
  expect(await storedObjects(tc)).toBe(BACKLOG - 200);

  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
});

test("a dry run never chains — it would recurse forever", async () => {
  // Nothing is deleted in a dry run, so the next pass would see the exact
  // same set and schedule another, without end.
  const { tc } = await ownerBackend();
  await tc.run(async (ctx) => {
    for (let i = 0; i < 250; i++) {
      await ctx.storage.store(new Blob([`orphan-${i}`], { type: "image/png" }));
    }
  });

  ageClock();
  const report = await tc.mutation(internal.files._sweep, {
    graceMs: 0,
    dryRun: true,
  });
  expect(report.done).toBe(false);
  expect(report.continued).toBe(false);
  await settle(tc);
  expect(await storedObjects(tc)).toBe(250); // untouched
});

test("storageReport distinguishes referenced from orphaned", async () => {
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Live" });
  const live = await upload(tc, as, "live");
  await upload(tc, as, "orphan");
  await as.mutation(api.pages.updateContent, {
    id: page,
    content: imageBlock(live.url),
    text: "",
  });

  const report = await tc.query(internal.admin.storageReport, {});
  expect(report.totalObjects).toBe(2);
  expect(report.unreferenced).toBe(1);
  expect(report.unreferencedKB).toBeGreaterThanOrEqual(0);
});

/* --------------------------- account wipe --------------------------- */

test("deleting an account leaves no bytes behind", async () => {
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Everything" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, { id: page, content: imageBlock(url), text: "" });
  // Plus a blob with no `files` row, which the by_owner sweep can't see.
  await tc.run(async (ctx) => {
    await ctx.storage.store(new Blob(["stray"], { type: "image/png" }));
  });

  const userId = await tc.run(
    async (ctx) => (await ctx.db.query("users").first())!._id,
  );
  await tc.mutation(internal.account.wipeUser, { userId });
  await settle(tc);
  // wipeUser deletes registered files directly; the stray one needs the
  // sweep, which is what the nightly cron is for.
  ageClock();
  await tc.mutation(internal.files._sweep, { graceMs: 0 });

  expect(await storedObjects(tc)).toBe(0);
  expect(await fileRows(tc)).toBe(0);
});

/* ------------------------- idempotence ------------------------------ */

test("reclaiming the same keys twice is harmless", async () => {
  const { tc, as } = await ownerBackend();
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Once" });
  const { url } = await upload(tc, as);
  await as.mutation(api.pages.updateContent, { id: page, content: imageBlock(url), text: "" });
  const key = url.split("/api/storage/")[1];

  await as.mutation(api.pages.trash, { id: page });
  await as.mutation(api.pages.deleteForever, { id: page });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);

  // A duplicate schedule (retry, replay) must not throw.
  await expect(
    tc.mutation(internal.files._reclaimKeys, { keys: [key] }),
  ).resolves.toEqual({ deleted: 0 });
});
