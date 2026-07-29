import { action } from "./_generated/server";
import { v } from "convex/values";
import { extractLinkMeta, normalizeUrl } from "./lib/linkMeta";

/**
 * Fetch Open Graph metadata for a bookmark block. Lives server-side because
 * the renderer can't fetch arbitrary origins (CORS); `fetch` is available in
 * the default Convex runtime, so no "use node" is needed.
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

export const fetchMeta = action({
  args: { url: v.string() },
  handler: async (_ctx, args) => {
    const url = normalizeUrl(args.url);
    if (!url) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          // Plenty of sites serve a stub to unknown agents; ask for HTML.
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; VellumBot/1.0)",
        },
      });
      if (!res.ok) return null;
      const type = res.headers.get("content-type") ?? "";
      if (type && !type.includes("html")) return null;

      // Cap the read — a 200MB response must not blow up the action.
      const buffer = await res.arrayBuffer();
      const html = new TextDecoder("utf-8", { fatal: false }).decode(
        buffer.byteLength > MAX_BYTES ? buffer.slice(0, MAX_BYTES) : buffer,
      );
      const meta = extractLinkMeta(html);
      return { ...meta, url: res.url || url };
    } catch {
      // Unreachable host, timeout, TLS failure — the block falls back to a
      // plain link card, so a null here is a normal outcome, not an error.
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
});
