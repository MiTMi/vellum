/**
 * Deep links to a specific block ("Copy link to block" in Notion).
 *
 * The link is a URL hash rather than a custom scheme, so the same string
 * works in the browser build and inside Electron (which also has a
 * location.hash). Format: `#/page/<pageId>/block/<blockId>`.
 */

export interface BlockAnchor {
  pageId: string;
  blockId: string;
}

export function anchorHash(pageId: string, blockId: string): string {
  return `#/page/${encodeURIComponent(pageId)}/block/${encodeURIComponent(blockId)}`;
}

export function anchorUrl(pageId: string, blockId: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${anchorHash(pageId, blockId)}`;
}

export function parseAnchor(hash: string): BlockAnchor | null {
  const m = /^#\/page\/([^/]+)\/block\/([^/]+)$/.exec(hash);
  if (!m) return null;
  return {
    pageId: decodeURIComponent(m[1]),
    blockId: decodeURIComponent(m[2]),
  };
}

/**
 * Scroll a block into view and flash it. The editor mounts asynchronously
 * after navigation, so poll briefly for the target instead of assuming it's
 * already in the DOM.
 */
export function scrollToBlock(blockId: string, timeoutMs = 3000): void {
  const started = Date.now();
  const tick = () => {
    const el = document.querySelector(
      `[data-id="${CSS.escape(blockId)}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("block-flash");
      setTimeout(() => el.classList.remove("block-flash"), 1600);
      return;
    }
    if (Date.now() - started < timeoutMs) setTimeout(tick, 100);
  };
  tick();
}
