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
  await settle(tc);
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
  await settle(tc);
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
  expect(guarded.candidates).toBe(0); // nothing even nominated
  await settle(tc);
  expect(await storedObjects(tc)).toBe(1);

  ageClock();
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
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
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
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
  expect(report.candidates).toBe(1);
  await settle(tc);
  expect(await storedObjects(tc)).toBe(1); // still there
  expect(await fileRows(tc)).toBe(1);
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
  expect(first.candidates).toBe(BACKLOG); // all nominated in one scan
  // Destroying is capped per pass and continues itself, so the whole
  // backlog clears within this chain rather than over 2 nightly crons.
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
  expect(report.candidates).toBe(250);
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
  ).resolves.toEqual({ candidates: 1 });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
});

/* ------------------- the vault ciphertext blind spot ---------------- */

test("a blob is not swept while vault ciphertext could be referencing it", async () => {
  // The mark phase reads plaintext. A storage URL sealed inside a vault
  // page's {__venc, iv, data} envelope is base64 — collectStorageKeys sees
  // no /api/storage/ and reports nothing, and "nothing" must not be read as
  // "unreferenced" or the sweep deletes an image the user can still see.
  const { tc, as, userId } = await ownerBackend();
  // Uploaded back when the Vault still accepted uploads.
  vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  const { storageId } = await upload(tc, as, "sealed-in-the-vault");
  expect(await storedObjects(tc)).toBe(1);

  // A vault page the server cannot read. Its ciphertext may or may not
  // mention that blob — the point is that nothing here can tell.
  await tc.run(async (ctx) => {
    await ctx.db.insert("pages", {
      ownerId: userId as Id<"users">,
      title: "venc1:aXY=:c2VjcmV0",
      type: "doc",
      rank: 1,
      vault: true,
      searchText: "",
      updatedAt: Date.now(),
      content: { __venc: 1, iv: "aXY=", data: "Y2lwaGVydGV4dA==" },
    });
  });

  // Sweep "now". Anchored to the REAL clock, not an absolute date:
  // convex-test stamps `_storage._creationTime` from real time — fake
  // timers never reach it — so a fixed date here becomes a time bomb the
  // day the calendar passes it (this test broke on 2026-08-14 exactly
  // that way). A future-of-real cutoff keeps the blob nominated forever.
  vi.setSystemTime(vi.getRealSystemTime() + 60_000);
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(1);

  // The targeted path consults the same scan and must hold the same line.
  const key = await tc.run(async (ctx) => {
    const row = (await ctx.db.query("files").collect())[0];
    return row.storageKey!;
  });
  await tc.mutation(internal.files._reclaimKeys, { keys: [key] });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(1);

  // Once no unreadable vault content remains, the orphan is reclaimable
  // again — the guard is a "can't prove it", not a permanent exemption.
  await tc.run(async (ctx) => {
    const page = (await ctx.db.query("pages").collect())[0];
    await ctx.db.delete("pages", page._id);
  });
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
  expect(storageId).toBeTruthy();
});

test("vault ciphertext does not protect blobs uploaded after the ban", async () => {
  // Uploads into the Vault have been refused since 2026-08-12, so a newer
  // blob provably isn't sealed in one. Without that bound, one encrypted
  // page would switch the sweep off for the whole workspace forever.
  const { tc, as, userId } = await ownerBackend();
  await tc.run(async (ctx) => {
    await ctx.db.insert("pages", {
      ownerId: userId as Id<"users">,
      title: "venc1:aXY=:c2VjcmV0",
      type: "doc",
      rank: 1,
      vault: true,
      searchText: "",
      updatedAt: Date.now(),
      content: { __venc: 1, iv: "aXY=", data: "Y2lwaGVydGV4dA==" },
    });
  });
  // The fake clock starts at real now, which is already past the ban —
  // no absolute date needed (a fixed one detonates when the calendar
  // passes it; see the real-clock note in the previous test).
  await upload(tc, as, "after-the-ban");
  ageClock();
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
});

/* ------------------ batched scanning (the read limit) --------------- */

test("a reference in the LAST batch still saves the blob", async () => {
  // The whole reason the scan is chained: proving a key unreferenced means
  // reading every page, and one transaction can't. If a batch boundary is
  // mishandled — a cursor that skips ties, a decision taken before the walk
  // finishes — the symptom is exactly this: a live image deleted because
  // the page referencing it was never reached. Putting the only reference
  // in the final batch is what makes that failure visible.
  const { tc, as } = await ownerBackend();
  const { url } = await upload(tc, as, "referenced-late");
  const PAGES = 60; // > SCAN_BATCH (50), so at least two passes

  let last: string | null = null;
  for (let i = 0; i < PAGES; i++) {
    last = await as.mutation(api.pages.create, { type: "doc", title: `P${i}` });
  }
  await as.mutation(api.pages.updateContent, {
    id: last as never,
    content: imageBlock(url),
    text: "",
  });
  expect(await storedObjects(tc)).toBe(1);

  ageClock();
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(1); // survived the batch boundary
});

test("the batched scan still reclaims once the last reference is gone", async () => {
  // The other half: batching must not make the sweep so timid it never
  // deletes anything. Same shape, reference removed.
  const { tc, as } = await ownerBackend();
  const { url } = await upload(tc, as, "briefly-referenced");
  let last: string | null = null;
  for (let i = 0; i < 60; i++) {
    last = await as.mutation(api.pages.create, { type: "doc", title: `P${i}` });
  }
  await as.mutation(api.pages.updateContent, {
    id: last as never,
    content: imageBlock(url),
    text: "",
  });
  await as.mutation(api.pages.trash, { id: last as never });
  await as.mutation(api.pages.deleteForever, { id: last as never });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(0);
});

test("a reference held only by a version in a later batch is honoured", async () => {
  // pageVersions is walked as a second phase after pages. A snapshot deep
  // in that table is the same hazard one table over.
  const { tc, as } = await ownerBackend();
  const { url } = await upload(tc, as, "in-history");
  const page = await as.mutation(api.pages.create, { type: "doc", title: "Edited" });
  await as.mutation(api.pages.updateContent, { id: page, content: imageBlock(url), text: "" });
  // Push the image out of the live page; only the snapshot still holds it.
  ageClock(11 * 60 * 1000);
  await as.mutation(api.pages.updateContent, {
    id: page,
    content: [{ type: "paragraph", content: [] }],
    text: "",
  });
  // Bulk up both tables so the snapshot isn't in the first batch.
  for (let i = 0; i < 60; i++) {
    const p = await as.mutation(api.pages.create, { type: "doc", title: `P${i}` });
    await as.mutation(api.pages.updateContent, { id: p, content: [], text: "x" });
  }

  ageClock();
  await tc.mutation(internal.files._sweep, { graceMs: 0 });
  await settle(tc);
  expect(await storedObjects(tc)).toBe(1); // history must survive a restore
});
