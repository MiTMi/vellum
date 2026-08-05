/// <reference types="vite/client" />
/**
 * The publish-to-web lifecycle, exactly as the Help Center describes it:
 * publishing mints an unguessable slug, publishing again keeps it, and
 * unpublishing destroys it so the old URL can never come back. Trashed pages
 * stop being served even while they hold a slug, and Vault pages can't be
 * published at all.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob([
  "../convex/pages.ts",
  "../convex/account.ts",
  "../convex/files.ts",
  "../convex/versions.ts",
  "../convex/comments.ts",
  "../convex/migrate.ts",
  "../convex/schema.ts",
  "../convex/lib/*.ts",
  "../convex/_generated/*.js",
]);

function t() {
  return convexTest(schema, modules).withIdentity({ subject: "owner|test" });
}

test("publishing mints a slug, re-publishing keeps it, unpublishing kills it", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Public page",
  });

  const slug = await ctx.mutation(api.pages.setPublished, { id, value: true });
  expect(typeof slug).toBe("string");
  expect(slug!.length).toBeGreaterThanOrEqual(16); // unguessable, not a title

  // The slug is what makes the page reachable.
  const served = await ctx.query(internal.pages.bySlug, { slug: slug! });
  expect(served?.title).toBe("Public page");

  // Publishing twice must not invalidate a link that has been shared.
  const again = await ctx.mutation(api.pages.setPublished, { id, value: true });
  expect(again).toBe(slug);

  // Unpublishing revokes the URL permanently.
  await ctx.mutation(api.pages.setPublished, { id, value: false });
  expect(await ctx.query(internal.pages.bySlug, { slug: slug! })).toBeNull();

  // Publishing again gives a *different* link — the old one stays dead.
  const fresh = await ctx.mutation(api.pages.setPublished, { id, value: true });
  expect(fresh).not.toBe(slug);
});

test("a trashed page stops being served even while it holds a slug", async () => {
  const ctx = t();
  const id = await ctx.mutation(api.pages.create, { type: "doc", title: "Bye" });
  const slug = await ctx.mutation(api.pages.setPublished, { id, value: true });
  expect(await ctx.query(internal.pages.bySlug, { slug: slug! })).not.toBeNull();

  await ctx.mutation(api.pages.trash, { id });
  expect(await ctx.query(internal.pages.bySlug, { slug: slug! })).toBeNull();
});

test("Vault pages cannot be published", async () => {
  const ctx = t();
  const vault = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Vault",
    vault: true,
  });
  await expect(
    ctx.mutation(api.pages.setPublished, { id: vault, value: true }),
  ).rejects.toThrow();
});
