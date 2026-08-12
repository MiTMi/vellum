import { normalizeUrl } from "./linkMeta";
import { safeFetch } from "./safefetch";

/**
 * Web access for the AI agent (docs/ai-agent-design.md follow-up,
 * 2026-08-12): a `webSearch` tool backed by Tavily, and a free
 * `fetchUrl` tool that reads one page's text (same fetch pattern as
 * linkPreview.fetchMeta).
 *
 * Provider history, so nobody re-litigates it: Brave and Google
 * adapters (random pick + failover) shipped first and were replaced the
 * same day — Google discontinued "search the entire web" engines in
 * March 2026 and closes the Custom Search JSON API entirely on
 * 2027-01-01; Brave's free tier became $5/month in credits behind a
 * mandatory card. Tavily won: 1,000 free credits/month, no card,
 * LLM-agent-shaped API. The multi-provider policy lives in git history
 * (commit 205593a) if a second engine is ever wanted again.
 *
 *   npx convex env set TAVILY_API_KEY "tvly-..." [--prod]
 *
 * The key is a Convex env var — never VITE_* (it would be inlined into
 * the client bundle, same rule as OPENROUTER_API_KEY).
 *
 * Privacy, from Tavily's own policy (checked 2026-08-12): query text is
 * collected, retained while the account exists, may be used to improve
 * their service, and may be shared with third-party search indexes.
 * Only the model-composed query string is ever sent — never page
 * content wholesale — and only when the user's globe toggle is on.
 */

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

const RESULT_COUNT = 5;
const SEARCH_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_FETCH_BYTES = 512 * 1024;
/** Page text handed to the model per fetchUrl call. */
const MAX_PAGE_TEXT_CHARS = 6000;

export function searchConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
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

/**
 * One Tavily basic search (1 credit). Null when no key is configured
 * (the agent then never offers the tool); throws on provider failure —
 * the agent degrades that to "answer from what you have".
 */
export async function webSearch(query: string): Promise<WebResult[] | null> {
  if (!searchConfigured()) return null;
  const res = await timedFetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: RESULT_COUNT,
      }),
    },
    SEARCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const body = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (body.results ?? [])
    .filter((r) => r.url)
    .slice(0, RESULT_COUNT)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: r.content ?? "",
    }));
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
    // safeFetch: SSRF-guarded, every redirect hop re-validated.
    const res = await safeFetch(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain",
          "User-Agent": "Mozilla/5.0 (compatible; VellumBot/1.0)",
        },
      },
      FETCH_TIMEOUT_MS,
    );
    if (!res || !res.ok) return null;
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
