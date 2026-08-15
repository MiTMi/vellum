// The chat panel's display-markdown parser (src/lib/chatMarkdown.ts):
// pure tree output consumed by the ChatMarkdown component. Its sibling
// markdownBlocks.ts drops inline styling on purpose (page content); this
// one exists precisely to render it, so the tests pin the inline layer.
import { expect, test } from "vitest";
import { parseChatMarkdown, parseInline } from "../src/lib/chatMarkdown";

test("inline: code, bold, italic, links", () => {
  expect(parseInline("run `npm test` **now** or *later*")).toEqual([
    { kind: "text", text: "run " },
    { kind: "code", text: "npm test" },
    { kind: "text", text: " " },
    { kind: "bold", text: "now" },
    { kind: "text", text: " or " },
    { kind: "italic", text: "later" },
  ]);
  expect(parseInline("see [docs](https://example.com/x)")).toEqual([
    { kind: "text", text: "see " },
    { kind: "link", text: "docs", href: "https://example.com/x" },
  ]);
});

test("inline: snake_case never italicizes; non-http links render as text", () => {
  expect(parseInline("the file_name_here stays plain")).toEqual([
    { kind: "text", text: "the file_name_here stays plain" },
  ]);
  expect(parseInline("_(a real aside)_")).toEqual([
    { kind: "italic", text: "(a real aside)" },
  ]);
  // javascript: (or any non-http target) must not become a clickable link.
  const demoted = parseInline("[x](javascript:alert(1))");
  expect(demoted.every((n) => n.kind === "text")).toBe(true);
  expect(demoted[0].text.startsWith("x")).toBe(true);
});

test("inline: markers inside code spans stay literal", () => {
  expect(parseInline("`**not bold**`")).toEqual([
    { kind: "code", text: "**not bold**" },
  ]);
});

test("blocks: headings, lists group, quotes, rules", () => {
  const tree = parseChatMarkdown(
    "## Plan\n- one\n- two\n1. first\n2. second\n> note\n---\ndone",
  );
  expect(tree.map((b) => b.kind)).toEqual([
    "heading",
    "bullets",
    "numbered",
    "quote",
    "rule",
    "paragraph",
  ]);
  const bullets = tree[1] as { items: unknown[] };
  const numbered = tree[2] as { items: unknown[] };
  expect(bullets.items).toHaveLength(2);
  expect(numbered.items).toHaveLength(2);
});

test("blocks: fenced code keeps its body verbatim, even unclosed", () => {
  const closed = parseChatMarkdown("```xml\n<key>Name</key>\n```\nafter");
  expect(closed[0]).toEqual({ kind: "code", text: "<key>Name</key>" });
  expect(closed[1].kind).toBe("paragraph");
  // A reply cut off mid-fence must still render the tail as code.
  const cut = parseChatMarkdown("```\nline1\nline2");
  expect(cut).toEqual([{ kind: "code", text: "line1\nline2" }]);
});

test("blocks: checklist markers render as list glyphs, deep headings clamp", () => {
  const tree = parseChatMarkdown("- [x] done\n- [ ] todo\n##### deep");
  const bullets = tree[0] as { items: { kind: string; text: string }[][] };
  expect(bullets.items[0][0].text.startsWith("☑")).toBe(true);
  expect(bullets.items[1][0].text.startsWith("☐")).toBe(true);
  expect(tree[1]).toMatchObject({ kind: "heading", level: 3 });
});
