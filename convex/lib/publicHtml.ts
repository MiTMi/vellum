import { withAutoDir } from "./htmlDir";

/**
 * Server-side rendering of a page for "Publish to web".
 *
 * The published page is served by an HTTP action, so it cannot use BlockNote
 * (a browser editor) to produce HTML — this is a small, dependency-free
 * renderer for the same block shapes.
 *
 * Security rules that must not be relaxed:
 *  - every value that reaches the output goes through `escapeHtml`;
 *  - `href`/`src` are restricted to http(s), so no `javascript:` URL can be
 *    smuggled in through a link or an image block;
 *  - links to other pages render as plain text, never as URLs — a published
 *    page must not leak the existence or ids of unpublished ones.
 *
 * Pure and tested (tests/publicHtml.test.ts).
 */

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

/** Only http(s) survives; anything else becomes empty (attribute omitted). */
export function safeUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return "";
  // A quote or angle bracket can't appear unescaped in an attribute anyway,
  // but reject control characters outright rather than relying on escaping.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return "";
  return escapeHtml(trimmed);
}

type Json = Record<string, unknown>;

const asArray = (v: unknown): Json[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : [];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Inline content: styled text runs, links, and page mentions. */
function inlineToHtml(content: unknown, titles: Record<string, string>): string {
  if (typeof content === "string") return escapeHtml(content);
  return asArray(content)
    .map((node) => {
      const type = str(node.type);

      if (type === "link") {
        const href = safeUrl(node.href);
        const inner = inlineToHtml(node.content, titles);
        return href ? `<a href="${href}" rel="nofollow noreferrer">${inner}</a>` : inner;
      }

      // A mention of another page: show the title, never a link.
      if (type === "pageMention") {
        const props = (node.props ?? {}) as Json;
        const title = titles[str(props.pageId)] ?? "Untitled";
        return `<span class="mention">${escapeHtml(title)}</span>`;
      }

      if (type !== "text") return "";

      let html = escapeHtml(str(node.text));
      const styles = (node.styles ?? {}) as Json;
      if (styles.code) html = `<code>${html}</code>`;
      if (styles.bold) html = `<strong>${html}</strong>`;
      if (styles.italic) html = `<em>${html}</em>`;
      if (styles.underline) html = `<u>${html}</u>`;
      if (styles.strike) html = `<s>${html}</s>`;
      return html;
    })
    .join("");
}

const LIST_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
]);

function blockToHtml(block: Json, titles: Record<string, string>): string {
  const type = str(block.type);
  const props = (block.props ?? {}) as Json;
  const inner = inlineToHtml(block.content, titles);
  const children = renderBlocks(block.children, titles);

  switch (type) {
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(props.level) || 1));
      return `<h${level}>${inner}</h${level}>${children}`;
    }
    case "quote":
      return `<blockquote>${inner}${children}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${inner}</code></pre>`;
    case "checkListItem": {
      const checked = props.checked === true ? " checked" : "";
      return `<li class="task"><input type="checkbox" disabled${checked}> ${inner}${children}</li>`;
    }
    case "bulletListItem":
    case "numberedListItem":
      return `<li>${inner}${children}</li>`;
    case "image": {
      const src = safeUrl(props.url);
      if (!src) return "";
      const caption = str(props.caption);
      return `<figure><img src="${src}" alt="${escapeHtml(caption)}" loading="lazy">${
        caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""
      }</figure>`;
    }
    case "video": {
      const src = safeUrl(props.url);
      return src ? `<video src="${src}" controls></video>` : "";
    }
    case "audio": {
      const src = safeUrl(props.url);
      return src ? `<audio src="${src}" controls></audio>` : "";
    }
    case "file": {
      const src = safeUrl(props.url);
      const name = escapeHtml(str(props.name) || "Download");
      return src ? `<p><a href="${src}" rel="nofollow noreferrer">${name}</a></p>` : "";
    }
    case "embed": {
      const src = safeUrl(props.url);
      if (!src) return "";
      // The stored value is the original share URL, not the iframe src, so
      // the published page links out rather than guessing an embed URL.
      return `<p class="embed-link"><a href="${src}" rel="nofollow noreferrer">${src}</a></p>`;
    }
    case "bookmark": {
      const href = safeUrl(props.url);
      if (!href) return "";
      const title = escapeHtml(str(props.title) || str(props.url));
      const desc = str(props.description);
      return `<a class="bookmark" href="${href}" rel="nofollow noreferrer"><span class="bookmark-title">${title}</span>${
        desc ? `<span class="bookmark-desc">${escapeHtml(desc)}</span>` : ""
      }</a>`;
    }
    case "callout": {
      const emoji = escapeHtml(str(props.emoji) || "💡");
      return `<div class="callout"><span class="callout-emoji">${emoji}</span><div>${inner}${children}</div></div>`;
    }
    case "equation": {
      const latex = escapeHtml(str(props.latex));
      return latex ? `<pre class="equation">${latex}</pre>` : "";
    }
    case "table":
      return tableToHtml(block, titles);
    case "pageLink": {
      const title = titles[str(props.pageId)] ?? "Untitled";
      // Deliberately not a link: the target may well be private.
      return `<p class="subpage">${escapeHtml(title)}</p>`;
    }
    case "toc":
      return ""; // navigational chrome, meaningless in a static export
    case "divider":
      return "<hr>";
    default:
      return inner || children ? `<p>${inner}${children}</p>` : "";
  }
}

function tableToHtml(block: Json, titles: Record<string, string>): string {
  const content = (block.content ?? {}) as Json;
  const rows = asArray(content.rows);
  if (!rows.length) return "";
  const body = rows
    .map((row) => {
      const cells = asArray(row.cells)
        .map((cell) => {
          // Cells are either an inline array or {type:"tableCell", content}.
          const inner = Array.isArray(cell)
            ? inlineToHtml(cell, titles)
            : inlineToHtml((cell as Json).content, titles);
          return `<td>${inner}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table>${body}</table>`;
}

/** Consecutive list items are wrapped in one <ul>/<ol>, as HTML requires. */
export function renderBlocks(
  blocks: unknown,
  titles: Record<string, string> = {},
): string {
  const list = asArray(blocks);
  let html = "";
  let openList: "ul" | "ol" | null = null;

  const closeList = () => {
    if (openList) {
      html += `</${openList}>`;
      openList = null;
    }
  };

  for (const block of list) {
    const type = str(block.type);
    if (LIST_TYPES.has(type)) {
      const want = type === "numberedListItem" ? "ol" : "ul";
      if (openList !== want) {
        closeList();
        html += `<${want}>`;
        openList = want;
      }
    } else {
      closeList();
    }
    html += blockToHtml(block, titles);
  }
  closeList();
  return html;
}

export interface PublicPageInput {
  title: string;
  icon?: string | null;
  blocks: unknown;
  updatedAt: number;
  /** pageId → title, for sub-page links and mentions. */
  titles?: Record<string, string>;
}

export function renderPublicPage(input: PublicPageInput): string {
  const title = input.title.trim() || "Untitled";
  const body = withAutoDir(renderBlocks(input.blocks, input.titles ?? {}));
  const updated = new Date(input.updatedAt).toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; --fg:#37352f; --bg:#fff; --muted:#787774; --line:rgba(55,53,47,.14); --accent:#2383e2; --soft:#f7f6f3; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e9e9e7; --bg:#191919; --muted:#9b9a97; --line:rgba(255,255,255,.14); --accent:#5b9bd5; --soft:#252525; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 16px; line-height: 1.65;
  }
  main { max-width: 46rem; margin: 0 auto; padding: 4rem 1.25rem 6rem; }
  .icon { font-size: 3.5rem; line-height: 1; }
  h1 { font-size: 2.4rem; line-height: 1.2; margin: .4em 0 .6em; }
  h2 { font-size: 1.5rem; margin: 1.6em 0 .4em; }
  h3 { font-size: 1.2rem; margin: 1.4em 0 .3em; }
  p, li { margin: .45em 0; }
  a { color: var(--accent); }
  ul, ol { padding-inline-start: 1.5em; }
  li.task { list-style: none; margin-inline-start: -1.2em; }
  code { background: var(--soft); border-radius: 3px; padding: .1em .35em; font-size: .9em; }
  pre { background: var(--soft); border-radius: 6px; padding: 1em; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: .8em 0; padding-inline-start: 1em; border-inline-start: 3px solid var(--line); color: var(--muted); }
  img, video { max-width: 100%; border-radius: 6px; }
  figure { margin: 1em 0; }
  figcaption { font-size: .85em; color: var(--muted); margin-top: .4em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; display: block; overflow-x: auto; }
  td { border: 1px solid var(--line); padding: .4em .6em; }
  .callout { display: flex; gap: .7em; background: var(--soft); border-radius: 6px; padding: .9em 1em; margin: 1em 0; }
  .bookmark { display: block; border: 1px solid var(--line); border-radius: 6px; padding: .7em .9em; margin: 1em 0; text-decoration: none; color: inherit; }
  .bookmark-title { display: block; font-weight: 600; }
  .bookmark-desc { display: block; font-size: .9em; color: var(--muted); }
  .mention { border-bottom: 1px solid var(--line); }
  .subpage { color: var(--muted); }
  footer { margin-top: 4rem; padding-top: 1.2rem; border-top: 1px solid var(--line); font-size: .85em; color: var(--muted); }
</style>
</head>
<body>
<main>
${input.icon ? `<div class="icon">${escapeHtml(input.icon)}</div>` : ""}
<h1 dir="auto">${escapeHtml(title)}</h1>
${body}
<footer>Last updated ${updated} · Published with Vellum</footer>
</main>
</body>
</html>`;
}
