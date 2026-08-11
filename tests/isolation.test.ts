/// <reference types="vite/client" />
/**
 * Tenant-isolation suite (Phase 1, docs/multi-user-plan.md): two real users
 * on one backend; user B attacks every function with user A's ids. No
 * invite goes out until this file is green.
 *
 * Read rule: foreign pages are indistinguishable from missing (null/empty).
 * Write rule: foreign pages throw "Not authorized" (loud, deterministic).
 */
import { expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { addUser, freshBackend, OWNER_EMAIL } from "./helpers";
import { redeemInviteForNewUser } from "../convex/lib/invites";
import { assertPageQuota } from "../convex/lib/quotas";
import { Id } from "../convex/_generated/dataModel";

/** One backend, two signed-in users, and a page A owns. */
async function twoUsers() {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const b = await addUser(tc, "bob@vellum.test");
  const pageA = await a.as.mutation(api.pages.create, {
    type: "doc",
    title: "Alice private notes",
  });
  await a.as.mutation(api.pages.updateContent, {
    id: pageA,
    content: [{ type: "paragraph", content: [{ type: "text", text: "secret zebra", styles: {} }] }],
    text: "secret zebra",
  });
  return { tc, a, b, pageA };
}

/* ------------------------------- reads ------------------------------- */

test("B cannot read A's page through any read surface", async () => {
  const { a, b, pageA } = await twoUsers();

  expect(await b.as.query(api.pages.get, { id: pageA })).toBeNull();
  expect(await b.as.query(api.pages.getMany, { ids: [pageA] })).toHaveLength(0);
  expect(
    (await b.as.query(api.pages.list, {})).map((p) => p._id),
  ).not.toContain(pageA);
  expect(
    (await b.as.query(api.pages.syncIndex, {})).map((p) => p._id),
  ).not.toContain(pageA);
  expect(await b.as.query(api.pages.search, { term: "zebra" })).toHaveLength(0);
  // ...while A still finds it.
  expect(
    (await a.as.query(api.pages.search, { term: "zebra" })).map((h) => h._id),
  ).toContain(pageA);
  expect(await b.as.query(api.pages.backlinks, { id: pageA })).toHaveLength(0);
  expect(await b.as.query(api.versions.list, { pageId: pageA })).toHaveLength(0);
  expect(await b.as.query(api.comments.list, { pageId: pageA })).toHaveLength(0);
});

test("B's trash and emptyTrash never see A's pages", async () => {
  const { a, b, pageA } = await twoUsers();
  await a.as.mutation(api.pages.trash, { id: pageA });
  expect(await b.as.query(api.pages.trashed, {})).toHaveLength(0);
  await b.as.mutation(api.pages.emptyTrash, {});
  // A's trashed page survived B's emptyTrash.
  expect((await a.as.query(api.pages.trashed, {})).map((p) => p._id)).toContain(pageA);
});

/* ------------------------------ writes ------------------------------- */

test("every write mutation rejects A's page for B", async () => {
  const { b, pageA } = await twoUsers();
  const rejects = async (p: Promise<unknown>) =>
    await expect(p).rejects.toThrow(/Not authorized/);

  await rejects(b.as.mutation(api.pages.rename, { id: pageA, title: "hacked" }));
  await rejects(
    b.as.mutation(api.pages.updateContent, { id: pageA, content: [], text: "x" }),
  );
  await rejects(b.as.mutation(api.pages.setIcon, { id: pageA, icon: "💀" }));
  await rejects(b.as.mutation(api.pages.setCover, { id: pageA, cover: null }));
  await rejects(b.as.mutation(api.pages.setPageOptions, { id: pageA, locked: true }));
  await rejects(b.as.mutation(api.pages.toggleFavorite, { id: pageA }));
  await rejects(b.as.mutation(api.pages.setTemplate, { id: pageA, value: true }));
  await rejects(b.as.mutation(api.pages.move, { id: pageA, rank: 1 }));
  await rejects(b.as.mutation(api.pages.duplicate, { id: pageA }));
  await rejects(b.as.mutation(api.pages.trash, { id: pageA }));
  await rejects(b.as.mutation(api.pages.restore, { id: pageA }));
  await rejects(b.as.mutation(api.pages.deleteForever, { id: pageA }));
  await rejects(
    b.as.mutation(api.pages.updateDbProps, { id: pageA, dbProps: [] }),
  );
  await rejects(
    b.as.mutation(api.pages.setRowProp, { id: pageA, propId: "x", value: 1 }),
  );
  await rejects(b.as.mutation(api.pages.setView, { id: pageA, activeView: "board" }));
  await rejects(b.as.mutation(api.pages.setViews, { id: pageA, views: [] }));
  await rejects(b.as.mutation(api.pages.setPublished, { id: pageA, value: true }));
  await rejects(b.as.mutation(api.comments.add, { pageId: pageA, text: "hi" }));
});

test("parent-ownership invariant: B cannot create/move under A's page", async () => {
  const { b, pageA } = await twoUsers();
  await expect(
    b.as.mutation(api.pages.create, { type: "doc", parentId: pageA }),
  ).rejects.toThrow(/Not authorized/);
  await expect(
    b.as.mutation(api.pages.createWithDoc, {
      clientKey: "k1",
      title: "smuggled",
      type: "doc",
      parentId: pageA,
      rank: 1,
      updatedAt: Date.now(),
    }),
  ).rejects.toThrow(/Not authorized/);
  const own = await b.as.mutation(api.pages.create, { type: "doc", title: "mine" });
  await expect(
    b.as.mutation(api.pages.move, { id: own, parentId: pageA, rank: 1 }),
  ).rejects.toThrow(/Not authorized/);
  await expect(
    b.as.mutation(api.pages.duplicate, { id: own, parentId: pageA }),
  ).rejects.toThrow(/Not authorized/);
});

test("B cannot touch A's comments or versions through their ids", async () => {
  const { a, b, pageA } = await twoUsers();
  const commentId = await a.as.mutation(api.comments.add, {
    pageId: pageA,
    text: "note to self",
  });
  await expect(
    b.as.mutation(api.comments.setResolved, { id: commentId!, value: true }),
  ).rejects.toThrow(/Not authorized/);
  await expect(
    b.as.mutation(api.comments.remove, { id: commentId! }),
  ).rejects.toThrow(/Not authorized/);

  // Force a version snapshot, then read it as B.
  await a.as.mutation(api.pages.updateContent, {
    id: pageA,
    content: [{ type: "paragraph", content: [] }],
    text: "",
  });
  const versions = await a.as.query(api.versions.list, { pageId: pageA });
  if (versions.length > 0) {
    expect(await b.as.query(api.versions.get, { id: versions[0]._id })).toBeNull();
  }
});

test("createWithDoc clientKey replay is idempotent per owner only", async () => {
  const { a, b } = await twoUsers();
  const args = {
    clientKey: "shared-key",
    title: "offline page",
    type: "doc" as const,
    rank: 1,
    updatedAt: Date.now(),
  };
  const first = await a.as.mutation(api.pages.createWithDoc, args);
  const replay = await a.as.mutation(api.pages.createWithDoc, args);
  expect(replay).toBe(first); // same owner → idempotent
  const other = await b.as.mutation(api.pages.createWithDoc, args);
  expect(other).not.toBe(first); // different owner → their own page
});

test("ownerId can't be forged through createWithDoc", async () => {
  const { a, b } = await twoUsers();
  const forged = await b.as.mutation(api.pages.createWithDoc, {
    clientKey: "forge",
    title: "forged",
    type: "doc",
    rank: 1,
    updatedAt: Date.now(),
    ownerId: a.userId as Id<"users">, // dropped server-side
  });
  expect(await a.as.query(api.pages.get, { id: forged })).toBeNull();
  expect(await b.as.query(api.pages.get, { id: forged })).not.toBeNull();
});

/* ---------------------------- workspaces ----------------------------- */

test("both users bootstrap their own welcome page independently", async () => {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const b = await addUser(tc, "bob@vellum.test");
  expect(await a.as.mutation(api.pages.bootstrap, {})).not.toBeNull();
  expect(await b.as.mutation(api.pages.bootstrap, {})).not.toBeNull();
  expect(await a.as.query(api.pages.list, {})).toHaveLength(1);
  expect(await b.as.query(api.pages.list, {})).toHaveLength(1);
  // Second bootstrap per user is a no-op.
  expect(await a.as.mutation(api.pages.bootstrap, {})).toBeNull();
});

test("published pages never leak foreign titles through link blocks", async () => {
  const { tc, a, b, pageA } = await twoUsers();
  // B publishes a page whose content embeds A's page id as a link block.
  const evil = await b.as.mutation(api.pages.create, { type: "doc", title: "evil" });
  await b.as.mutation(api.pages.updateContent, {
    id: evil,
    content: [{ type: "pageLink", props: { pageId: pageA } }],
    text: "",
  });
  await b.as.mutation(api.pages.setPublished, { id: evil, value: true });
  const slug = (await tc.run(async (ctx) => {
    return await ctx.db
      .query("pages")
      .withIndex("by_publicSlug")
      .collect();
  })) as { publicSlug?: string }[];
  const published = slug.find((p) => p.publicSlug);
  const result = await tc.query(internal.pages.bySlug, {
    slug: published!.publicSlug!,
  });
  expect(result).not.toBeNull();
  expect(Object.keys(result!.titles)).not.toContain(pageA);
});

/* -------------------------------- AI --------------------------------- */

test("AI internals are scoped: B cannot retrieve or fill from A's pages", async () => {
  const { tc, b, pageA } = await twoUsers();
  const row = await tc.query(internal.ai._rowForFill, {
    pageId: pageA,
    userId: b.userId as Id<"users">,
  });
  expect(row).toBeNull();
  const docs = await tc.query(internal.ai._retrieve, {
    question: "zebra",
    userId: b.userId as Id<"users">,
  });
  expect(docs).toHaveLength(0);
});

/* ------------------------------ invites ------------------------------ */

async function newUserWithCode(tc: ReturnType<typeof freshBackend>, email: string, code?: string) {
  return (await tc.run(async (ctx) => {
    return await ctx.db.insert("users", { email, inviteCode: code });
  })) as Id<"users">;
}

test("sign-up requires a valid unredeemed invite; owner is exempt", async () => {
  const tc = freshBackend();
  await tc.run(async (ctx) => {
    await ctx.db.insert("invites", { code: "good-code", createdAt: 1 });
  });

  // No code → rejected (user creation would abort).
  const noCode = await newUserWithCode(tc, "x@vellum.test");
  await expect(
    tc.run(async (ctx) => redeemInviteForNewUser(ctx, noCode)),
  ).rejects.toThrow(/invite code is required/);

  // Wrong code → rejected.
  const wrong = await newUserWithCode(tc, "y@vellum.test", "bad-code");
  await expect(
    tc.run(async (ctx) => redeemInviteForNewUser(ctx, wrong)),
  ).rejects.toThrow(/not valid/);

  // Right code → redeemed, and cleared from the user doc.
  const good = await newUserWithCode(tc, "z@vellum.test", "good-code");
  await tc.run(async (ctx) => redeemInviteForNewUser(ctx, good));
  await tc.run(async (ctx) => {
    const user = await ctx.db.get("users", good);
    expect(user?.inviteCode).toBeUndefined();
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code", (q) => q.eq("code", "good-code"))
      .unique();
    expect(invite?.redeemedBy).toBe(good);
  });

  // Second use of the same code → rejected.
  const late = await newUserWithCode(tc, "late@vellum.test", "good-code");
  await expect(
    tc.run(async (ctx) => redeemInviteForNewUser(ctx, late)),
  ).rejects.toThrow(/not valid/);

  // The owner sails through with no code at all.
  const owner = await newUserWithCode(tc, OWNER_EMAIL);
  await tc.run(async (ctx) => redeemInviteForNewUser(ctx, owner));
});

/* ------------------------------ quotas ------------------------------- */

test("page quota blocks non-owners and exempts the owner", async () => {
  const tc = freshBackend();
  const user = await addUser(tc, "quota@vellum.test");
  const owner = await addUser(tc, OWNER_EMAIL);
  await expect(
    tc.run(async (ctx) =>
      assertPageQuota(ctx, user.userId as Id<"users">, 2001),
    ),
  ).rejects.toThrow(/Page limit reached/);
  await tc.run(async (ctx) =>
    assertPageQuota(ctx, owner.userId as Id<"users">, 999_999),
  );
});

test("file quota: over-limit upload is deleted and refused; owner exempt", async () => {
  const tc = freshBackend();
  const user = await addUser(tc, "files@vellum.test");

  // A fake 60 MB object (metadata is what matters, not real bytes).
  const bigId = await tc.run(async (ctx) => {
    return await ctx.storage.store(new Blob([new Uint8Array(1024)]));
  });
  // Pretend it's over quota by attributing 49 MB of prior uploads.
  await tc.run(async (ctx) => {
    await ctx.db.insert("files", {
      storageId: bigId,
      ownerId: user.userId as Id<"users">,
      size: 49 * 1024 * 1024,
      createdAt: 1,
    });
  });
  const nextId = await tc.run(async (ctx) => {
    return await ctx.storage.store(new Blob([new Uint8Array(2 * 1024 * 1024)]));
  });
  const refused = await user.as.mutation(api.files.getFileUrl, {
    storageId: nextId,
  });
  expect(refused.url).toBeNull();
  expect(refused.error).toMatch(/doesn't fit/);
  // The refused file was deleted from storage.
  const gone = await tc.run(async (ctx) => {
    return await ctx.db.system.get("_storage", nextId);
  });
  expect(gone).toBeNull();

  // At the cap, generateUploadUrl refuses early too.
  await tc.run(async (ctx) => {
    await ctx.db.insert("files", {
      storageId: bigId,
      ownerId: user.userId as Id<"users">,
      size: 2 * 1024 * 1024,
      createdAt: 2,
    });
  });
  await expect(
    user.as.mutation(api.files.generateUploadUrl, {}),
  ).rejects.toThrow(/Storage is full/);
});

/* ----------------------------- AI budget ----------------------------- */

test("AI budget: user cap, pool cap, owner exemption", async () => {
  const tc = freshBackend();
  const user = await addUser(tc, "ai@vellum.test");
  const other = await addUser(tc, "ai2@vellum.test");
  const owner = await addUser(tc, OWNER_EMAIL);
  const month = new Date().toISOString().slice(0, 7);

  // Under both caps → allowed.
  expect(
    await tc.query(internal.ai._budgetCheck, {
      userId: user.userId as Id<"users">,
    }),
  ).toEqual({ exempt: false });

  // Blow the per-user cap.
  await tc.run(async (ctx) => {
    await ctx.db.insert("aiUsage", {
      userId: user.userId as Id<"users">,
      month,
      costMicroUsd: 100_000,
      calls: 10,
    });
  });
  await expect(
    tc.query(internal.ai._budgetCheck, { userId: user.userId as Id<"users"> }),
  ).rejects.toThrow(/AI allowance/);

  // Blow the pool with someone else's spend → a third user is refused too.
  await tc.run(async (ctx) => {
    await ctx.db.insert("aiUsage", {
      userId: other.userId as Id<"users">,
      month,
      costMicroUsd: 800_000,
      calls: 5,
    });
  });
  const third = await addUser(tc, "ai3@vellum.test");
  await expect(
    tc.query(internal.ai._budgetCheck, { userId: third.userId as Id<"users"> }),
  ).rejects.toThrow(/shared AI budget/);

  // The owner is exempt regardless.
  expect(
    await tc.query(internal.ai._budgetCheck, {
      userId: owner.userId as Id<"users">,
    }),
  ).toEqual({ exempt: true });

  // Spend recording accumulates.
  await tc.mutation(internal.ai._recordSpend, {
    userId: third.userId as Id<"users">,
    costMicroUsd: 1234,
  });
  await tc.mutation(internal.ai._recordSpend, {
    userId: third.userId as Id<"users">,
    costMicroUsd: 1000,
  });
  const row = await tc.run(async (ctx) => {
    return await ctx.db
      .query("aiUsage")
      .withIndex("by_user_month", (q) =>
        q.eq("userId", third.userId as Id<"users">).eq("month", month),
      )
      .unique();
  });
  expect(row?.costMicroUsd).toBe(2234);
  expect(row?.calls).toBe(2);
});

/* --------------------------- account wipe ---------------------------- */

test("deleting a regular user erases only their data; owner blocked while others exist", async () => {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const owner = await addUser(tc, OWNER_EMAIL);
  const pageA = await a.as.mutation(api.pages.create, { type: "doc", title: "A" });
  const pageO = await owner.as.mutation(api.pages.create, { type: "doc", title: "O" });

  // Owner can't self-destruct while Alice exists.
  await expect(
    tc.mutation(internal.account.wipeUser, {
      userId: owner.userId as Id<"users">,
    }),
  ).rejects.toThrow(/Other accounts exist/);

  // Wiping Alice removes her page and user, leaves the owner's.
  await tc.mutation(internal.account.wipeUser, {
    userId: a.userId as Id<"users">,
  });
  await tc.run(async (ctx) => {
    expect(await ctx.db.get("pages", pageA)).toBeNull();
    expect(await ctx.db.get("pages", pageO)).not.toBeNull();
    expect(await ctx.db.get("users", a.userId as Id<"users">)).toBeNull();
  });
});

/* ----------------------- Phase 2: sharing ---------------------------- */
/* Owner A shares a subtree with B; C is a stranger. Design contract in
 * docs/phase2-sharing-design.md — B gets exactly the granted role inside
 * the subtree and nothing anywhere else; C's world is unchanged. */

/** A's subtree (root ← child), shared with B at `role`; C uninvolved. */
async function sharedFixture(role: "viewer" | "editor") {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const b = await addUser(tc, "bob@vellum.test");
  const c = await addUser(tc, "carol@vellum.test");
  const root = await a.as.mutation(api.pages.create, {
    type: "doc",
    title: "Family plans",
  });
  const child = await a.as.mutation(api.pages.create, {
    type: "doc",
    title: "Packing list",
    parentId: root,
  });
  const outside = await a.as.mutation(api.pages.create, {
    type: "doc",
    title: "Alice private",
  });
  await a.as.mutation(api.shares.add, {
    pageId: root,
    email: "bob@vellum.test",
    role,
  });
  return { tc, a, b, c, root, child, outside };
}

test("viewer B reads the whole subtree and nothing else; C sees nothing", async () => {
  const { b, c, root, child, outside } = await sharedFixture("viewer");

  expect(await b.as.query(api.pages.get, { id: root })).not.toBeNull();
  expect(await b.as.query(api.pages.get, { id: child })).not.toBeNull();
  expect(await b.as.query(api.pages.get, { id: outside })).toBeNull();

  // Sync surfaces: role-stamped entries for the subtree, nothing more.
  const index = await b.as.query(api.pages.syncIndex, {});
  const entries = new Map(index.map((e) => [e._id, e]));
  expect((entries.get(root) as { role?: string })?.role).toBe("viewer");
  expect((entries.get(child) as { role?: string })?.role).toBe("viewer");
  expect(entries.has(outside)).toBe(false);
  const docs = await b.as.query(api.pages.getMany, { ids: [root, child, outside] });
  expect(docs.map((d) => d._id).sort()).toEqual([root, child].sort());
  expect(docs.every((d) => (d as { role?: string }).role === "viewer")).toBe(true);

  // C: the stranger's world is unchanged by the share existing.
  expect(await c.as.query(api.pages.get, { id: root })).toBeNull();
  expect((await c.as.query(api.pages.syncIndex, {})).map((e) => e._id)).not.toContain(root);
});

test("viewer B cannot write anywhere in the subtree", async () => {
  const { b, root, child } = await sharedFixture("viewer");
  const rejects = async (p: Promise<unknown>) =>
    await expect(p).rejects.toThrow(/Not authorized/);
  await rejects(b.as.mutation(api.pages.updateContent, { id: root, content: [], text: "x" }));
  await rejects(b.as.mutation(api.pages.rename, { id: child, title: "hax" }));
  await rejects(b.as.mutation(api.pages.setRowProp, { id: child, propId: "p", value: 1 }));
  await rejects(b.as.mutation(api.pages.create, { type: "doc", parentId: root }));
});

test("editor B edits inside the subtree; owner-only surfaces stay closed", async () => {
  const { a, b, root, child, outside } = await sharedFixture("editor");

  await b.as.mutation(api.pages.rename, { id: child, title: "Packing (edited by B)" });
  await b.as.mutation(api.pages.updateContent, {
    id: child,
    content: [{ type: "paragraph", content: [{ type: "text", text: "socks", styles: {} }] }],
    text: "socks",
  });
  const asA = await a.as.query(api.pages.get, { id: child });
  expect(asA?.title).toBe("Packing (edited by B)");

  const rejects = async (p: Promise<unknown>) =>
    await expect(p).rejects.toThrow(/Not authorized/);
  // Owner-only mutations, even with editor role.
  await rejects(b.as.mutation(api.pages.move, { id: child, rank: 9 }));
  await rejects(b.as.mutation(api.pages.trash, { id: child }));
  await rejects(b.as.mutation(api.pages.duplicate, { id: child }));
  await rejects(b.as.mutation(api.pages.setPublished, { id: child, value: true }));
  await rejects(b.as.mutation(api.pages.toggleFavorite, { id: root }));
  await rejects(b.as.mutation(api.pages.setTemplate, { id: root, value: true }));
  // Only the owner manages shares — B cannot grant C access.
  await rejects(
    b.as.mutation(api.shares.add, { pageId: root, email: "carol@vellum.test", role: "viewer" }),
  );
  // And nothing outside the subtree opened up.
  await rejects(b.as.mutation(api.pages.rename, { id: outside, title: "hax" }));
});

test("editor B's create lands in A's ownership and stays idempotent on replay", async () => {
  const { tc, a, b, root } = await sharedFixture("editor");
  const args = {
    clientKey: "b-offline-create",
    title: "B's addition",
    type: "doc" as const,
    parentId: root,
    rank: 1,
    updatedAt: Date.now(),
  };
  const created = await b.as.mutation(api.pages.createWithDoc, args);
  const replay = await b.as.mutation(api.pages.createWithDoc, args);
  expect(replay).toBe(created); // accessibility-based idempotency
  await tc.run(async (ctx) => {
    const row = await ctx.db.get("pages", created);
    expect(row?.ownerId).toBe(a.userId); // parent-ownership invariant holds
  });
  // The page is A's: A can see and trash it like any of their own.
  expect(await a.as.query(api.pages.get, { id: created })).not.toBeNull();
  await a.as.mutation(api.pages.trash, { id: created });
});

test("vault pages are unshareable and unreachable through a shared ancestor", async () => {
  const { a, b, root } = await sharedFixture("editor");
  const vaultRoot = await a.as.mutation(api.pages.create, {
    type: "doc",
    title: "venc1:iv:data",
    vault: true,
    parentId: root, // vault root nested INSIDE the shared subtree
  });
  await expect(
    a.as.mutation(api.shares.add, { pageId: vaultRoot, email: "bob@vellum.test", role: "viewer" }),
  ).rejects.toThrow(/can't be shared/);
  // Not through get, not through sync, not through getMany.
  expect(await b.as.query(api.pages.get, { id: vaultRoot })).toBeNull();
  expect((await b.as.query(api.pages.syncIndex, {})).map((e) => e._id)).not.toContain(vaultRoot);
  expect(await b.as.query(api.pages.getMany, { ids: [vaultRoot] })).toHaveLength(0);
  // And B cannot plant a vault flag in A's tree.
  await expect(
    b.as.mutation(api.pages.create, { type: "doc", parentId: root, vault: true }),
  ).rejects.toThrow(/Not authorized/);
});

test("revocation closes every surface; role changes apply immediately", async () => {
  const { a, b, root, child } = await sharedFixture("editor");

  // Downgrade editor → viewer: reads stay, writes die.
  await a.as.mutation(api.shares.setRole, {
    pageId: root,
    userId: b.userId as Id<"users">,
    role: "viewer",
  });
  expect(await b.as.query(api.pages.get, { id: child })).not.toBeNull();
  await expect(
    b.as.mutation(api.pages.rename, { id: child, title: "still?" }),
  ).rejects.toThrow(/Not authorized/);

  // Revoke: reads null, writes throw, sync index empties.
  await a.as.mutation(api.shares.remove, {
    pageId: root,
    userId: b.userId as Id<"users">,
  });
  expect(await b.as.query(api.pages.get, { id: root })).toBeNull();
  expect(await b.as.query(api.pages.get, { id: child })).toBeNull();
  await expect(
    b.as.mutation(api.pages.updateContent, { id: child, content: [], text: "x" }),
  ).rejects.toThrow(/Not authorized/);
  expect((await b.as.query(api.pages.syncIndex, {})).map((e) => e._id)).not.toContain(root);
});

test("moving a page out of the shared subtree severs B's access to it", async () => {
  const { a, b, root, child } = await sharedFixture("viewer");
  await a.as.mutation(api.pages.move, { id: child, parentId: undefined, rank: 99 });
  expect(await b.as.query(api.pages.get, { id: child })).toBeNull();
  expect(await b.as.query(api.pages.get, { id: root })).not.toBeNull(); // root still shared
});

test("overlapping shares resolve to the highest role", async () => {
  const { a, b, root, child } = await sharedFixture("viewer");
  await a.as.mutation(api.shares.add, {
    pageId: child,
    email: "bob@vellum.test",
    role: "editor",
  });
  // Child: editor via the direct share, even though the root grant is viewer.
  await b.as.mutation(api.pages.rename, { id: child, title: "edited" });
  // Root: still viewer-only.
  await expect(
    b.as.mutation(api.pages.rename, { id: root, title: "nope" }),
  ).rejects.toThrow(/Not authorized/);
});

test("trashed shared pages stay readable but never writable for editors", async () => {
  const { a, b, child } = await sharedFixture("editor");
  await a.as.mutation(api.pages.trash, { id: child });
  // Still visible to sync (so the replica can mark it) …
  expect((await b.as.query(api.pages.syncIndex, {})).map((e) => e._id)).toContain(child);
  // … but not writable, even with editor role.
  await expect(
    b.as.mutation(api.pages.updateContent, { id: child, content: [], text: "x" }),
  ).rejects.toThrow(/Not authorized/);
});

test("share management guards: unknown email, self-share, foreign listing", async () => {
  const { a, b, c, root } = await sharedFixture("viewer");
  await expect(
    a.as.mutation(api.shares.add, { pageId: root, email: "nobody@vellum.test", role: "viewer" }),
  ).rejects.toThrow(/No Vellum account/);
  await expect(
    a.as.mutation(api.shares.add, { pageId: root, email: "alice@vellum.test", role: "viewer" }),
  ).rejects.toThrow(/already have access/);
  // listForPage is a read: foreign page reads as empty, not a throw.
  expect(await c.as.query(api.shares.listForPage, { pageId: root })).toHaveLength(0);
  // The owner sees the grant; B sees their side through listSharedWithMe.
  const grants = await a.as.query(api.shares.listForPage, { pageId: root });
  expect(grants.map((g) => g.email)).toContain("bob@vellum.test");
  const mine = await b.as.query(api.shares.listSharedWithMe, {});
  expect(mine.map((s) => s.pageId)).toContain(root);
  expect(await c.as.query(api.shares.listSharedWithMe, {})).toHaveLength(0);
});

test("deleteForever removes the page's share rows", async () => {
  const { tc, a, root, child } = await sharedFixture("viewer");
  await a.as.mutation(api.pages.trash, { id: root });
  await a.as.mutation(api.pages.deleteForever, { id: root });
  await tc.run(async (ctx) => {
    expect(await ctx.db.query("shares").collect()).toHaveLength(0);
    expect(await ctx.db.get("pages", child)).toBeNull();
  });
});
