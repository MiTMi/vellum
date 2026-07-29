import { LinkPreview } from "./types";

/**
 * Module-level handle on the data layer's link-preview fetcher.
 *
 * Custom BlockNote blocks render outside our React tree and can't reach
 * context reliably, so the bookmark block calls through here instead of a
 * hook — the same pattern as pageRegistry / editorRegistry.
 */

type Fetcher = (url: string) => Promise<LinkPreview | null>;

let fetcher: Fetcher | null = null;

export function setLinkPreviewFetcher(next: Fetcher | null) {
  fetcher = next;
}

export async function fetchLinkPreview(
  url: string,
): Promise<LinkPreview | null> {
  if (!fetcher) return null;
  try {
    return await fetcher(url);
  } catch {
    // Offline, blocked host, timeout — the block falls back to a plain card.
    return null;
  }
}
