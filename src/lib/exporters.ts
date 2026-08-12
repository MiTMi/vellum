import { DbProp, PageMeta } from "./types";
import { downloadFile, getActiveEditor, safeFilename } from "./editorRegistry";

const escapeHtml = (s: string) =>
  s.replace(
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

/**
 * A self-contained HTML document for export and printing. BlockNote's
 * `blocksToHTMLLossy` emits semantic HTML with no styling of its own, so the
 * stylesheet here is what makes an exported file (and the PDF rendered from
 * it) look like a document rather than a wall of unstyled text.
 */
/**
 * Strip dangerous URL schemes from exported HTML (audit fix 2026-08-12):
 * blocksToHTMLLossy escapes content but passes link hrefs through, and the
 * browser print path document.writes the result into a SAME-ORIGIN window
 * — a javascript: href planted by a shared-page editor or an HTML import
 * would run with the app's origin. DOM-based, not regex: parse, walk,
 * drop anything that isn't http(s)/mailto/anchor-relative.
 */
function sanitizeExportHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("[href]")) {
    const href = el.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:|#)/i.test(href.trim())) el.removeAttribute("href");
  }
  for (const el of doc.querySelectorAll("[src]")) {
    const src = el.getAttribute("src") ?? "";
    if (!/^(https?:|data:image\/|blob:)/i.test(src.trim())) el.remove();
  }
  for (const el of doc.querySelectorAll("script, iframe, object, embed")) {
    el.remove();
  }
  return doc.body.innerHTML;
}

function printableHtml(title: string, rawBody: string): string {
  const heading = escapeHtml(title || "Untitled");
  const body = sanitizeExportHtml(rawBody);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${heading}</title>
<style>
  @page { margin: 18mm 16mm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 11.5pt;
    line-height: 1.6;
    color: #37352f;
    max-width: 46em;
    margin: 0 auto;
    padding: 2em 1em;
  }
  h1 { font-size: 2em; margin: 0 0 0.6em; }
  h2 { font-size: 1.45em; margin: 1.4em 0 0.4em; }
  h3 { font-size: 1.2em; margin: 1.2em 0 0.3em; }
  p, li { margin: 0.4em 0; }
  ul, ol { padding-left: 1.4em; }
  a { color: #2383e2; }
  code {
    background: #f2f1ee;
    border-radius: 3px;
    padding: 0.1em 0.35em;
    font-size: 0.9em;
  }
  pre {
    background: #f7f6f3;
    border-radius: 5px;
    padding: 0.9em 1em;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  blockquote {
    margin: 0.8em 0;
    padding-left: 1em;
    border-left: 3px solid #d9d8d4;
    color: #5f5e5a;
  }
  img { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
  th, td { border: 1px solid #d9d8d4; padding: 0.4em 0.6em; text-align: left; }
  th { background: #f7f6f3; }
  /* Keep headings with the text that follows, and never split a block. */
  h1, h2, h3 { break-after: avoid; }
  pre, blockquote, table, img { break-inside: avoid; }
</style>
</head>
<body>
<h1>${heading}</h1>
${body}
</body>
</html>`;
}

export async function exportPageMarkdown(title: string): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const md = await editor.blocksToMarkdownLossy();
  downloadFile(
    `${safeFilename(title)}.md`,
    `# ${title || "Untitled"}\n\n${md}`,
    "text/markdown",
  );
  return true;
}

export async function copyPageMarkdown(title: string): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const md = await editor.blocksToMarkdownLossy();
  await navigator.clipboard.writeText(`# ${title || "Untitled"}\n\n${md}`);
  return true;
}

export async function exportPageHTML(title: string): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const html = await editor.blocksToHTMLLossy();
  downloadFile(
    `${safeFilename(title)}.html`,
    printableHtml(title, html),
    "text/html",
  );
  return true;
}

export type PdfResult = "saved" | "cancelled" | "printed" | "failed";

/**
 * Electron renders the page to a real PDF through the main process (native
 * save dialog, no print dialog). In a browser there is no way to write a PDF
 * directly, so we hand the same document to the print dialog, where "Save as
 * PDF" is a destination — hence the two distinct success results.
 */
export async function exportPagePDF(title: string): Promise<PdfResult> {
  const editor = getActiveEditor();
  if (!editor) return "failed";
  const html = printableHtml(title, await editor.blocksToHTMLLossy());

  const native = window.vellum?.exportPdf;
  if (native) {
    const res = await native(html, `${safeFilename(title)}.pdf`);
    if (res.ok) return "saved";
    return res.canceled ? "cancelled" : "failed";
  }

  const win = window.open("", "_blank");
  if (!win) return "failed"; // popup blocked
  win.document.write(html);
  win.document.close();
  // Give the new document a tick to lay out before the print dialog opens.
  win.setTimeout(() => {
    win.focus();
    win.print();
  }, 250);
  return "printed";
}

/**
 * Append an imported file's content to the open page. Markdown and HTML both
 * round-trip through BlockNote's parsers; anything else is treated as plain
 * text (which Markdown parsing handles gracefully).
 */
export async function importFileIntoPage(file: File): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const text = await file.text();
  const name = file.name.toLowerCase();
  const isHtml =
    name.endsWith(".html") ||
    name.endsWith(".htm") ||
    file.type === "text/html";

  const blocks = isHtml
    ? await editor.tryParseHTMLToBlocks(text)
    : await editor.tryParseMarkdownToBlocks(text);
  if (!blocks.length) return false;

  const doc = editor.document;
  const last = doc[doc.length - 1];
  editor.insertBlocks(blocks, last ? last.id : undefined, "after");
  return true;
}

export function exportDatabaseCSV(
  title: string,
  dbProps: DbProp[],
  rows: PageMeta[],
) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Name", ...dbProps.map((p) => p.name)].map(esc).join(",");
  const lines = rows.map((row) => {
    const cells = [row.title || "Untitled"];
    for (const prop of dbProps) {
      const raw = row.props?.[prop.id];
      if (raw === undefined || raw === null) {
        cells.push("");
      } else if (prop.type === "select" && typeof raw === "string") {
        cells.push(prop.options?.find((o) => o.id === raw)?.name ?? "");
      } else if (prop.type === "multiSelect" && Array.isArray(raw)) {
        cells.push(
          (raw as string[])
            .map((id) => prop.options?.find((o) => o.id === id)?.name ?? "")
            .filter(Boolean)
            .join("; "),
        );
      } else if (prop.type === "checkbox") {
        cells.push(raw === true ? "true" : "false");
      } else {
        cells.push(String(raw));
      }
    }
    return cells.map(esc).join(",");
  });
  downloadFile(
    `${safeFilename(title)}.csv`,
    [header, ...lines].join("\n"),
    "text/csv",
  );
}
