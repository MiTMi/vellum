import { expect, test } from "vitest";
import {
  extractLinkMeta,
  hostLabel,
  normalizeUrl,
} from "../convex/lib/linkMeta";

test("prefers Open Graph tags over <title>", () => {
  const html = `
    <html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Real Title">
      <meta property="og:description" content="A short summary.">
      <meta property="og:image" content="https://cdn.example.com/a.png">
    </head><body>ignored</body></html>`;
  expect(extractLinkMeta(html)).toEqual({
    title: "Real Title",
    description: "A short summary.",
    image: "https://cdn.example.com/a.png",
  });
});

test("falls back to <title> and name= description", () => {
  const html = `<head><title>  Plain\n  Page </title>
    <meta name="description" content="Just a description."></head>`;
  const meta = extractLinkMeta(html);
  expect(meta.title).toBe("Plain Page");
  expect(meta.description).toBe("Just a description.");
  expect(meta.image).toBe("");
});

test("handles attribute order, single quotes and entities", () => {
  const html = `<meta content='Tom &amp; Jerry&#39;s' property='og:title'>`;
  expect(extractLinkMeta(html).title).toBe("Tom & Jerry's");
});

test("twitter tags are used when og is absent", () => {
  const html = `<meta name="twitter:title" content="Tweet Title">`;
  expect(extractLinkMeta(html).title).toBe("Tweet Title");
});

test("malformed markup yields empty fields, not a throw", () => {
  expect(extractLinkMeta("<<<not html")).toEqual({
    title: "",
    description: "",
    image: "",
  });
  expect(extractLinkMeta("").title).toBe("");
});

test("normalizeUrl adds https and rejects non-http schemes", () => {
  expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
  expect(normalizeUrl("http://example.com/")).toBe("http://example.com/");
  expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com/");
  expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeUrl("file:///etc/passwd")).toBeNull();
  expect(normalizeUrl("localhost")).toBeNull(); // no dot → not a URL
  expect(normalizeUrl("")).toBeNull();
});

test("hostLabel strips scheme and www", () => {
  expect(hostLabel("https://www.github.com/x/y")).toBe("github.com");
  expect(hostLabel("not a url")).toBe("not a url");
});
