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
