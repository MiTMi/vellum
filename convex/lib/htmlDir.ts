/**
 * Adds `dir="auto"` to every block-level element in a rendered document
 * (2026-09-23), so each paragraph, heading, list, quote and table cell of a
 * published page or an HTML/PDF export takes its direction from its own
 * text — Hebrew lays out right-to-left, English left-to-right, on the same
 * page. Pure string work: published pages are rendered server-side and PDF
 * export runs with JavaScript disabled, so nothing can detect direction at
 * view time. Leaves an element that already carries a `dir` alone.
 */
const BLOCK_TAGS = /<(p|h[1-6]|li|ul|ol|blockquote|td|th|figcaption)(?=[\s>])(?![^>]*\sdir=)/g;
const CALLOUT = /<div class="callout"(?![^>]*\sdir=)/g;

export function withAutoDir(html: string): string {
  return html
    .replace(BLOCK_TAGS, '<$1 dir="auto"')
    .replace(CALLOUT, '<div class="callout" dir="auto"');
}
