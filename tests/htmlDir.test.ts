import { expect, test } from "vitest";
import { withAutoDir } from "../convex/lib/htmlDir";
import { renderPublicPage } from "../convex/lib/publicHtml";

test("withAutoDir tags block elements, leaves inline markup and existing dir alone", () => {
  const out = withAutoDir(
    '<h2>כותרת</h2><p class="x">שלום <strong>עולם</strong></p><ul><li>a</li></ul>' +
      '<blockquote>q</blockquote><p dir="ltr">keep</p><pre><code>x</code></pre>' +
      '<div class="callout"><span>💡</span></div>',
  );
  expect(out).toContain('<h2 dir="auto">');
  expect(out).toContain('<p dir="auto" class="x">');
  expect(out).toContain("<strong>"); // inline untouched
  expect(out).toContain('<ul dir="auto"><li dir="auto">');
  expect(out).toContain('<blockquote dir="auto">');
  expect(out).toContain('<p dir="ltr">keep</p>'); // never overridden
  expect(out).toContain("<pre><code>"); // code stays LTR
  expect(out).toContain('<div class="callout" dir="auto">');
  expect(withAutoDir(out)).toBe(out); // idempotent
});

test("published pages carry per-block direction for Hebrew content", () => {
  const html = renderPublicPage({
    title: "רשימת קניות",
    blocks: [
      { type: "paragraph", content: [{ type: "text", text: "שלום עולם", styles: {} }] },
    ],
    updatedAt: 0,
  } as never);
  expect(html).toContain('<h1 dir="auto">רשימת קניות</h1>');
  expect(html).toMatch(/<p dir="auto">שלום עולם<\/p>/);
  // Logical properties, so quotes and list indents flip for RTL blocks.
  expect(html).toContain("border-inline-start");
});
