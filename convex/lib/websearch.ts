import { normalizeUrl } from "./linkMeta";

/**
 * Web access for the AI agent (docs/ai-agent-design.md follow-up,
 * 2026-08-12): a `webSearch` tool backed by Brave and/or Google
 * Programmable Search, and a free `fetchUrl` tool that reads one page's
 * text (same fetch pattern as linkPreview.fetchMeta).
 *
 * Provider policy — decided with Michael: pick RANDOMLY among the
 * configured providers so both free tiers wear evenly, and fail over to
 * the other on any error (an exhausted quota must degrade to "the other
 * engine answers", never to a failed search). Providers appear only when
 * their env keys exist:
 *
 *   npx convex env set BRAVE_SEARCH_API_KEY  "..." [--prod]
 *   npx convex env set GOOGLE_SEARCH_API_KEY "..." [--prod]
 *   npx convex env set GOOGLE_SEARCH_CX     "..." [--prod]  (engine id)
 *
 * Keys are Convex env vars — never VITE_* (they'd be inlined into the
 * client bundle, same rule as OPENROUTER_API_KEY).
 */

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = "brave" | "google";

const RESULT_COUNT = 5;
const SEARCH_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_FETCH_BYTES = 512 * 1024;
/** Page text handed to the model per fetchUrl call. */
const MAX_PAGE_TEXT_CHARS = 6000;

export function configuredProviders(): SearchProvider[] {
  const out: SearchProvider[] = [];
  if (process.env.BRAVE_SEARCH_API_KEY) out.push("brave");
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    out.push("google");
  }
  return out;
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function braveSearch(query: string): Promise<WebResult[]> {
  const res = await timedFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${RESULT_COUNT}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
    SEARCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const body = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (body.web?.results ?? [])
    .filter((r) => r.url)
    .slice(0, RESULT_COUNT)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: r.description ?? "",
    }));
}

async function googleSearch(query: string): Promise<WebResult[]> {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY!,
    cx: process.env.GOOGLE_SEARCH_CX!,
    q: query,
    num: String(RESULT_COUNT),
  });
  const res = await timedFetch(
    `https://www.googleapis.com/customsearch/v1?${params}`,
    { headers: { Accept: "application/json" } },
    SEARCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`google ${res.status}`);
  const body = (await res.json()) as {
    items?: { title?: string; link?: string; snippet?: string }[];
  };
  return (body.items ?? [])
    .filter((r) => r.link)
    .slice(0, RESULT_COUNT)
    .map((r) => ({
      title: r.title ?? r.link!,
      url: r.link!,
      snippet: r.snippet ?? "",
    }));
}

const RUNNERS: Record<SearchProvider, (q: string) => Promise<WebResult[]>> = {
  brave: braveSearch,
  google: googleSearch,
};

/**
 * Random provider, failover to the rest on any error. Returns null when
 * no provider is configured (the agent then never offers the tool) and
 * throws only when every configured provider failed.
 */
export async function webSearch(
  query: string,
): Promise<{ provider: SearchProvider; results: WebResult[] } | null> {
  const providers = configuredProviders();
  if (providers.length === 0) return null;
  // Even wear across free tiers; order is a uniform shuffle of the pool.
  const order = [...providers].sort(() => Math.random() - 0.5);
  let lastErr: unknown = null;
  for (const provider of order) {
    try {
      return { provider, results: await RUNNERS[provider](query) };
    } catch (err) {
      lastErr = err; // quota/network/5xx — try the next provider
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("web search failed");
}

/** Crude but dependency-free HTML → text: drop script/style, strip tags,
 *  decode the handful of entities that matter, collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch one page's readable text — the free tool. http(s) only (via
 * normalizeUrl, the same gate the bookmark fetcher uses), capped read,
 * null for anything unreachable or non-HTML: the agent tells the model
 * "that page is not available" rather than erroring the turn.
 */
export async function fetchUrlText(
  rawUrl: string,
): Promise<{ url: string; text: string } | null> {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  try {
    const res = await timedFetch(
      url,
      {
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain",
          "User-Agent": "Mozilla/5.0 (compatible; VellumBot/1.0)",
        },
      },
      FETCH_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|text\/plain/.test(type)) return null;
    const buffer = await res.arrayBuffer();
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(
      buffer.byteLength > MAX_FETCH_BYTES ? buffer.slice(0, MAX_FETCH_BYTES) : buffer,
    );
    const text = (type.includes("plain") ? raw : htmlToText(raw)).slice(
      0,
      MAX_PAGE_TEXT_CHARS,
    );
    if (!text) return null;
    return { url: res.url || url, text };
  } catch {
    return null;
  }
}
