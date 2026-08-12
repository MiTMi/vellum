/// <reference types="vite/client" />
// The agent's web tools: provider configuration, the random-pick-with-
// failover search policy, HTML→text extraction, and the fetchUrl gate.
// All network is stubbed.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configuredProviders,
  fetchUrlText,
  htmlToText,
  webSearch,
} from "../convex/lib/websearch";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_CX;
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

const BRAVE_BODY = {
  web: { results: [{ title: "Brave hit", url: "https://a.example", description: "d" }] },
};
const GOOGLE_BODY = {
  items: [{ title: "Google hit", link: "https://b.example", snippet: "s" }],
};

test("providers appear only with their keys (google needs key AND cx)", () => {
  expect(configuredProviders()).toEqual([]);
  process.env.GOOGLE_SEARCH_API_KEY = "k";
  expect(configuredProviders()).toEqual([]); // cx missing
  process.env.GOOGLE_SEARCH_CX = "cx";
  expect(configuredProviders()).toEqual(["google"]);
  process.env.BRAVE_SEARCH_API_KEY = "b";
  expect(configuredProviders()).toEqual(["brave", "google"]);
});

test("no providers configured → null, no network", async () => {
  expect(await webSearch("anything")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("single provider parses results", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "b";
  fetchMock.mockResolvedValue(ok(BRAVE_BODY));
  const out = await webSearch("query");
  expect(out?.provider).toBe("brave");
  expect(out?.results).toEqual([
    { title: "Brave hit", url: "https://a.example", snippet: "d" },
  ]);
  expect(fetchMock.mock.calls[0][0]).toContain("api.search.brave.com");
});

test("a failing provider fails over to the other", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "b";
  process.env.GOOGLE_SEARCH_API_KEY = "g";
  process.env.GOOGLE_SEARCH_CX = "cx";
  // Whichever is tried first 429s; the second answers.
  fetchMock.mockImplementation(async (url: string) => {
    if (fetchMock.mock.calls.length === 1) {
      return { ok: false, status: 429, headers: new Headers(), json: async () => ({}) } as unknown as Response;
    }
    return ok(String(url).includes("brave") ? BRAVE_BODY : GOOGLE_BODY);
  });
  const out = await webSearch("query");
  expect(out).not.toBeNull();
  expect(out!.results).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("every provider failing throws", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "b";
  process.env.GOOGLE_SEARCH_API_KEY = "g";
  process.env.GOOGLE_SEARCH_CX = "cx";
  fetchMock.mockResolvedValue({
    ok: false, status: 500, headers: new Headers(), json: async () => ({}),
  } as unknown as Response);
  await expect(webSearch("query")).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
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
