/**
 * Open Graph / <title> extraction for the bookmark block.
 *
 * Kept as a pure function (no fetch, no Convex ctx) so it's unit-testable,
 * mirroring convex/lib/pageLinks.ts. The Convex runtime has no DOMParser, so
 * this is deliberately regex-based and tolerant of malformed markup.
 */

export interface LinkMeta {
  title: string;
  description: string;
  image: string;
}

/** Decode the handful of entities that actually show up in OG tags. */
function decodeEntities(text: string): string {
  return text
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&(?:amp|#38);/g, "&");
}

function clean(value: string | undefined, max = 300): string {
  if (!value) return "";
  return decodeEntities(value).replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Find `content` for the first <meta> tag whose property/name matches any of
 * `keys`. Attribute order varies wildly in the wild, so match the whole tag
 * then pull the pieces out of it.
 */
function metaContent(html: string, keys: string[]): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const key of keys) {
    for (const tag of tags) {
      const nameMatch = tag.match(
        /\b(?:property|name)\s*=\s*["']?([^"'>\s]+)/i,
      );
      if (!nameMatch || nameMatch[1].toLowerCase() !== key) continue;
      const contentMatch = tag.match(
        /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
      );
      const value = contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3];
      if (value) return clean(value);
    }
  }
  return "";
}

export function extractLinkMeta(html: string): LinkMeta {
  const head = html.slice(0, 200_000); // metadata lives up top; cap the work
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title:
      metaContent(head, ["og:title", "twitter:title"]) ||
      clean(titleTag, 200),
    description: clean(
      metaContent(head, ["og:description", "twitter:description", "description"]),
    ),
    image: metaContent(head, ["og:image", "og:image:url", "twitter:image"]),
  };
}

/** Normalize user input into a fetchable http(s) URL, or null if it isn't one. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** "https://www.github.com/x" → "github.com" */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
