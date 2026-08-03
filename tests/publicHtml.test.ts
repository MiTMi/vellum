import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  renderBlocks,
  renderPublicPage,
  safeUrl,
} from "../convex/lib/publicHtml";

const text = (t: string, styles: Record<string, boolean> = {}) => ({
  type: "text",
  text: t,
  styles,
});

describe("escaping", () => {
  test("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });

  test("block text is escaped, so page content can't inject markup", () => {
    const html = renderBlocks([
      { type: "paragraph", content: [text("<img src=x onerror=alert(1)>")] },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("a title cannot break out of the document", () => {
    const html = renderPublicPage({
      title: "</title><script>alert(1)</script>",
      blocks: [],
      updatedAt: Date.now(),
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("safeUrl", () => {
  test.each([
    ["javascript:alert(1)", ""],
    ["JavaScript:alert(1)", ""],
    ["data:text/html,<script>", ""],
    ["file:///etc/passwd", ""],
    ["/relative/path", ""],
    ["", ""],
  ])("rejects %s", (input, expected) => {
    expect(safeUrl(input)).toBe(expected);
  });

  test("accepts and escapes http(s)", () => {
    expect(safeUrl("https://example.com/a?b=1&c=2")).toBe(
      "https://example.com/a?b=1&amp;c=2",
    );
  });

  test("a javascript: link renders as plain text, not an anchor", () => {
    const html = renderBlocks([
      {
        type: "paragraph",
        content: [
          { type: "link", href: "javascript:alert(1)", content: [text("click")] },
        ],
      },
    ]);
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
  });

  test("an image with a javascript: url is dropped entirely", () => {
    expect(renderBlocks([{ type: "image", props: { url: "javascript:x" } }])).toBe("");
  });
});

describe("block rendering", () => {
  test("headings clamp to h1–h3", () => {
    expect(renderBlocks([{ type: "heading", props: { level: 2 }, content: [text("Hi")] }]))
      .toBe("<h2>Hi</h2>");
    expect(renderBlocks([{ type: "heading", props: { level: 9 }, content: [text("Hi")] }]))
      .toBe("<h3>Hi</h3>");
  });

  test("inline styles nest", () => {
    const html = renderBlocks([
      { type: "paragraph", content: [text("x", { bold: true, italic: true })] },
    ]);
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
  });

  test("consecutive list items share one list element", () => {
    const html = renderBlocks([
      { type: "bulletListItem", content: [text("a")] },
      { type: "bulletListItem", content: [text("b")] },
      { type: "paragraph", content: [text("break")] },
      { type: "numberedListItem", content: [text("c")] },
    ]);
    expect(html).toBe("<ul><li>a</li><li>b</li></ul><p>break</p><ol><li>c</li></ol>");
  });

  test("checklist renders a disabled checkbox reflecting state", () => {
    const html = renderBlocks([
      { type: "checkListItem", props: { checked: true }, content: [text("done")] },
    ]);
    expect(html).toContain("disabled checked");
  });

  test("nested children are rendered", () => {
    const html = renderBlocks([
      {
        type: "bulletListItem",
        content: [text("parent")],
        children: [{ type: "bulletListItem", content: [text("child")] }],
      },
    ]);
    expect(html).toContain("child");
  });

  test("tables render rows and cells", () => {
    const html = renderBlocks([
      {
        type: "table",
        content: { rows: [{ cells: [[text("A")], [text("B")]] }] },
      },
    ]);
    expect(html).toBe("<table><tr><td>A</td><td>B</td></tr></table>");
  });

  test("unknown block types degrade to a paragraph instead of vanishing", () => {
    expect(renderBlocks([{ type: "somethingNew", content: [text("keep me")] }])).toBe(
      "<p>keep me</p>",
    );
  });
});

describe("privacy of linked pages", () => {
  test("a sub-page link shows its title but never a URL or id", () => {
    const html = renderBlocks([{ type: "pageLink", props: { pageId: "abc123" } }], {
      abc123: "Secret Plans",
    });
    expect(html).toContain("Secret Plans");
    expect(html).not.toContain("abc123");
    expect(html).not.toContain("<a");
  });

  test("an unknown page id falls back to Untitled, leaking nothing", () => {
    const html = renderBlocks([{ type: "pageLink", props: { pageId: "zzz" } }]);
    expect(html).toContain("Untitled");
    expect(html).not.toContain("zzz");
  });

  test("mentions are plain text too", () => {
    const html = renderBlocks(
      [{ type: "paragraph", content: [{ type: "pageMention", props: { pageId: "p1" } }] }],
      { p1: "Roadmap" },
    );
    expect(html).toContain("Roadmap");
    expect(html).not.toContain("p1");
  });
});

describe("full document", () => {
  test("includes the title, body and noindex, and is valid-ish HTML", () => {
    const html = renderPublicPage({
      title: "My Page",
      icon: "🚀",
      blocks: [{ type: "paragraph", content: [text("Hello")] }],
      updatedAt: Date.parse("2026-08-03T10:00:00Z"),
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Page</title>");
    expect(html).toContain("Hello");
    expect(html).toContain("🚀");
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain("2026-08-03");
  });

  test("survives malformed content without throwing", () => {
    for (const blocks of [null, undefined, "nonsense", [null], [{}], [{ type: 5 }]]) {
      expect(() =>
        renderPublicPage({ title: "t", blocks, updatedAt: 0 }),
      ).not.toThrow();
    }
  });
});
