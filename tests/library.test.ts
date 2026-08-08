import { expect, test } from "vitest";
import { libraryRows, LIBRARY_ID, isLibraryId } from "../src/lib/library";
import { formatVisitTime } from "../src/lib/visits";
import { PageId, PageMeta, PagesIndex, childrenKey } from "../src/lib/types";

function page(
  id: string,
  title: string,
  opts: Partial<PageMeta> = {},
): PageMeta {
  return {
    _id: id as PageId,
    title,
    type: "doc",
    parentId: null,
    rank: 1024,
    icon: null,
    cover: null,
    isFavorite: false,
    isTemplate: false,
    vault: false,
    props: null,
    updatedAt: 100,
    _creationTime: 50,
    ...opts,
  };
}

function indexOf(...pages: PageMeta[]): PagesIndex {
  const byId = new Map(pages.map((p) => [p._id as string, p]));
  const children = new Map<string, PageMeta[]>();
  for (const p of pages) {
    const key = childrenKey(p.parentId);
    children.set(key, [...(children.get(key) ?? []), p]);
  }
  return {
    loading: false,
    all: pages,
    byId,
    children,
    favorites: pages.filter((p) => p.isFavorite && !p.vault),
    templates: pages.filter((p) => p.isTemplate && !p.vault),
    vaultRoot: pages.find((p) => p.vault) ?? null,
  };
}

/* --------------------------- sentinel ---------------------------- */

test("the library sentinel is recognized and can't be a Convex id", () => {
  expect(isLibraryId(LIBRARY_ID)).toBe(true);
  expect(isLibraryId(null)).toBe(false);
  expect(isLibraryId("j57abc")).toBe(false);
  expect(LIBRARY_ID.startsWith("__")).toBe(true);
});

/* ---------------------------- recents ---------------------------- */

test("recents sorts by visit time, falling back to edit time", () => {
  const a = page("a", "A", { updatedAt: 10 });
  const b = page("b", "B", { updatedAt: 30 });
  const c = page("c", "C", { updatedAt: 20 });
  const rows = libraryRows(indexOf(a, b, c), "recents", { a: 100 }, "");
  // a was visited (100) > b edited (30) > c edited (20)
  expect(rows.map((r) => r.page._id)).toEqual(["a", "b", "c"]);
  expect(rows[0].visitedAt).toBe(100);
  expect(rows[1].visitedAt).toBeNull();
});

test("vault pages and templates never appear in recents or private", () => {
  const normal = page("n", "Normal");
  const vaulted = page("v", "venc1:zz:zz", { vault: true });
  const tpl = page("t", "Template", { isTemplate: true });
  const idx = indexOf(normal, vaulted, tpl);
  for (const tab of ["recents", "private"] as const) {
    const ids = libraryRows(idx, tab, {}, "").map((r) => r.page._id);
    expect(ids).toEqual(["n"]);
  }
  // ...but templates get their own tab.
  expect(libraryRows(idx, "templates", {}, "").map((r) => r.page._id)).toEqual(["t"]);
});

/* ------------------------ source & search ------------------------ */

test("source resolves the parent page; top-level pages are Private", () => {
  const parent = page("p", "Parent", { type: "database" });
  const child = page("c", "Child", { parentId: "p" as PageId });
  const rows = libraryRows(indexOf(parent, child), "private", {}, "");
  const childRow = rows.find((r) => r.page._id === "c")!;
  const parentRow = rows.find((r) => r.page._id === "p")!;
  expect(childRow.source?._id).toBe("p");
  expect(parentRow.source).toBeNull();
});

test("search filters by title, matching Untitled for empty titles", () => {
  const a = page("a", "Meeting notes");
  const b = page("b", "");
  const idx = indexOf(a, b);
  expect(libraryRows(idx, "private", {}, "meet").map((r) => r.page._id)).toEqual(["a"]);
  expect(libraryRows(idx, "private", {}, "untitled").map((r) => r.page._id)).toEqual(["b"]);
});

test("favorites tab mirrors the index favorites", () => {
  const a = page("a", "A", { isFavorite: true });
  const b = page("b", "B");
  expect(
    libraryRows(indexOf(a, b), "favorites", {}, "").map((r) => r.page._id),
  ).toEqual(["a"]);
});

/* ------------------------- time formatting ----------------------- */

test("formatVisitTime covers the Notion-style buckets", () => {
  const now = Date.parse("2026-08-08T12:00:00");
  expect(formatVisitTime(now - 30_000, now)).toBe("Just now");
  expect(formatVisitTime(now - 5 * 60_000, now)).toBe("5m ago");
  expect(formatVisitTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  expect(formatVisitTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  expect(formatVisitTime(now - 21 * 86_400_000, now)).toBe("3w ago");
  // Older than ~5 weeks: an absolute date.
  expect(formatVisitTime(Date.parse("2023-02-22T12:00:00"), now)).toMatch(/2023/);
});
