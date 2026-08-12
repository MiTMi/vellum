/// <reference types="vite/client" />
// The agent's web tools: Tavily configuration and parsing, HTML→text
// extraction, and the fetchUrl gate. All network is stubbed.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fetchUrlText,
  htmlToText,
  searchConfigured,
  webSearch,
} from "../convex/lib/websearch";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.TAVILY_API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

const TAVILY_BODY = {
  results: [
    { title: "Tavily hit", url: "https://a.example", content: "snippet text" },
  ],
};

test("search is configured only when the Tavily key exists", () => {
  expect(searchConfigured()).toBe(false);
  process.env.TAVILY_API_KEY = "tvly-x";
  expect(searchConfigured()).toBe(true);
});

test("no key → null, no network", async () => {
  expect(await webSearch("anything")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a search parses Tavily results and sends the key as a Bearer", async () => {
  process.env.TAVILY_API_KEY = "tvly-x";
  fetchMock.mockResolvedValue(ok(TAVILY_BODY));
  const out = await webSearch("query");
  expect(out).toEqual([
    { title: "Tavily hit", url: "https://a.example", snippet: "snippet text" },
  ]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("api.tavily.com/search");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-x");
  expect(JSON.parse(init.body as string).query).toBe("query");
});

test("provider failure throws (the agent degrades it, not the lib)", async () => {
  process.env.TAVILY_API_KEY = "tvly-x";
  fetchMock.mockResolvedValue({
    ok: false, status: 429, headers: new Headers(), json: async () => ({}),
  } as unknown as Response);
  await expect(webSearch("query")).rejects.toThrow(/tavily 429/);
});

test("htmlToText strips markup, scripts, and entities", () => {
  expect(
    htmlToText(
      "<html><script>evil()</script><style>.x{}</style><h1>Hi &amp; bye</h1><p>a  b</p></html>",
    ),
  ).toBe("Hi & bye a b");
});

test("fetchUrlText: html pages become text; non-http and non-html are null", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    url: "https://site.example/page",
    headers: new Headers({ "content-type": "text/html" }),
    arrayBuffer: async () => new TextEncoder().encode("<p>Hello <b>world</b></p>").buffer,
  } as unknown as Response);
  const out = await fetchUrlText("https://site.example/page");
  expect(out).toEqual({ url: "https://site.example/page", text: "Hello world" });

  expect(await fetchUrlText("ftp://nope.example")).toBeNull();
  expect(await fetchUrlText("javascript:alert(1)")).toBeNull();

  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    url: "https://site.example/img",
    headers: new Headers({ "content-type": "image/png" }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response);
  expect(await fetchUrlText("https://site.example/img")).toBeNull();
});
