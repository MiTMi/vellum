/**
 * Contextual search snippets: the slice of a page's body text around the
 * first match, the way Notion shows why a result matched.
 *
 * Shared by the server `pages.search` query and the client replica's
 * `useSearch` (offline/mock), so every mode produces identical snippets —
 * same argument as extractPageLinks in ./pageLinks.ts.
 */

const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 80;

/**
 * Returns null when the term doesn't appear in the body — the caller then
 * shows just the title, because a snippet would add nothing.
 */
export function makeSnippet(
  contentText: string | undefined,
  term: string,
): string | null {
  const text = (contentText ?? "").replace(/\s+/g, " ").trim();
  const needle = term.trim().toLowerCase();
  if (!text || !needle) return null;

  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return null;

  let start = Math.max(0, at - CONTEXT_BEFORE);
  let end = Math.min(text.length, at + needle.length + CONTEXT_AFTER);

  // Snap to word boundaries so we don't slice mid-word.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > at + needle.length) end = space;
  }

  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end).trim() +
    (end < text.length ? "…" : "")
  );
}
