import { expect, test } from "vitest";
import { extractPageLinks } from "../../convex/lib/pageLinks";

test("extractPageLinks finds pageLink ids at any depth", () => {
  const content = [
    { type: "paragraph", content: [{ type: "text", text: "hi" }] },
    { type: "pageLink", props: { pageId: "a" }, content: [] },
    {
      type: "bulletListItem",
      content: [],
      children: [
        { type: "pageLink", props: { pageId: "b" } },
        {
          type: "paragraph",
          children: [{ type: "pageLink", props: { pageId: "c" } }],
        },
      ],
    },
  ];
  expect(extractPageLinks(content).sort()).toEqual(["a", "b", "c"]);
});

test("extractPageLinks ignores empty ids, other blocks, and non-arrays", () => {
  expect(extractPageLinks(undefined)).toEqual([]);
  expect(extractPageLinks("nope")).toEqual([]);
  expect(
    extractPageLinks([
      { type: "pageLink", props: { pageId: "" } },
      { type: "paragraph", props: { pageId: "not-a-link" } },
    ]),
  ).toEqual([]);
});

test("extractPageLinks finds inline pageMention chips too", () => {
  const content = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "see " },
        { type: "pageMention", props: { pageId: "m1" } },
        { type: "text", text: " and " },
        { type: "pageMention", props: { pageId: "m2" } },
      ],
    },
    { type: "pageLink", props: { pageId: "b1" } },
  ];
  expect(extractPageLinks(content).sort()).toEqual(["b1", "m1", "m2"]);
});

test("a page linked by both a block and a mention is reported once per node", () => {
  // The backlinks UI dedupes by page, but extraction is per-reference.
  const content = [
    { type: "pageLink", props: { pageId: "x" } },
    { type: "paragraph", content: [{ type: "pageMention", props: { pageId: "x" } }] },
  ];
  expect(extractPageLinks(content)).toEqual(["x", "x"]);
});
