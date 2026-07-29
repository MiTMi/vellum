import { expect, test } from "vitest";
import { makeSnippet } from "../convex/lib/snippet";

const LONG =
  "The quick brown fox jumps over the lazy dog. " +
  "Pack my box with five dozen liquor jugs. " +
  "How vexingly quick daft zebras jump across the meadow at dawn.";

test("returns context around the first match, elided at the front", () => {
  const s = makeSnippet(LONG, "liquor")!;
  expect(s).toContain("liquor");
  expect(s.startsWith("…")).toBe(true);
  // Shorter than the whole body — it's a window, not the full text.
  expect(s.length).toBeLessThan(LONG.length);
});

test("elides both ends when the match sits inside a long body", () => {
  const body = `${"filler words ".repeat(20)}NEEDLE${" more filler".repeat(20)}`;
  const s = makeSnippet(body, "needle")!;
  expect(s).toContain("NEEDLE");
  expect(s.startsWith("…")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
});

test("no leading ellipsis when the match is at the start", () => {
  const s = makeSnippet(LONG, "The quick")!;
  expect(s.startsWith("…")).toBe(false);
  expect(s).toContain("The quick");
});

test("no trailing ellipsis when the match runs to the end", () => {
  const s = makeSnippet("short body text", "body")!;
  expect(s).toBe("short body text");
});

test("matching is case-insensitive", () => {
  expect(makeSnippet(LONG, "QUICK")).toContain("quick");
});

test("returns null when the term isn't in the body", () => {
  expect(makeSnippet(LONG, "platypus")).toBeNull();
  expect(makeSnippet(undefined, "anything")).toBeNull();
  expect(makeSnippet("", "anything")).toBeNull();
  expect(makeSnippet(LONG, "   ")).toBeNull();
});

test("collapses whitespace so snippets stay single-line", () => {
  const s = makeSnippet("alpha\n\n   beta\tgamma", "beta")!;
  expect(s).toBe("alpha beta gamma");
});

test("handles non-ascii text without slicing mid-character", () => {
  const s = makeSnippet("café añejo — naïve résumé notes", "añejo")!;
  expect(s).toContain("añejo");
});
