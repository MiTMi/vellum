/**
 * Markdown ⇄ BlockNote blocks, server-side edition.
 *
 * The app's own helper (`src/lib/markdownBlocks.ts`) emits *partial* blocks
 * and lets BlockNote fill in ids when the editor mounts. Nothing here ever
 * mounts an editor, so blocks are written complete — id, props, inline runs,
 * children — in exactly the shape BlockNote stores, so a page written by the
 * MCP server is indistinguishable from one typed in the app (block anchors,
 * history previews and search all read it the same way).
 *
 * Deliberately line-oriented, like the app's helper: headings, lists,
 * checklists, quotes, fenced code and paragraphs. Inline markup (bold,
 * links) rides through as literal text rather than risking a mis-parse.
 */
import { randomUUID } from "node:crypto";

/** Search text is capped the way `extractText` in the app caps it. */
export const MAX_SEARCH_TEXT = 8000;

export function textRun(text) {
  return { type: "text", text, styles: {} };
}

function makeBlock(type, text, props = {}) {
  return {
    id: randomUUID(),
    type,
    props,
    content: [textRun(text)],
    children: [],
  };
}

/**
 * @param {string} markdown
 * @returns {{ blocks: object[], text: string }} blocks plus the plain text
 *   `pages.updateContent` wants for search.
 */
export function markdownToBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // Fenced code: everything up to the closing fence, verbatim.
    let m = line.match(/^```\s*([\w+-]*)\s*$/);
    if (m) {
      const language = m[1] || "text";
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      blocks.push(makeBlock("codeBlock", body.join("\n"), { language }));
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue; // horizontal rule
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push(
        makeBlock("heading", m[2].trim(), { level: Math.min(3, m[1].length) }),
      );
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push(makeBlock("quote", m[1].trim()));
    } else if ((m = line.match(/^[-*+]\s+\[( |x|X)\]\s+(.*)$/))) {
      blocks.push(
        makeBlock("checkListItem", m[2].trim(), {
          checked: m[1].toLowerCase() === "x",
        }),
      );
    } else if ((m = line.match(/^[-*+]\s+(.*)$/))) {
      blocks.push(makeBlock("bulletListItem", m[1].trim()));
    } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      blocks.push(makeBlock("numberedListItem", m[1].trim()));
    } else {
      blocks.push(makeBlock("paragraph", line));
    }
  }

  return { blocks, text: extractText(blocks) };
}

function inlineText(content) {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") out += item.text;
    else if (item.type === "link" && Array.isArray(item.content)) {
      const label = inlineText(item.content);
      out += item.href ? `[${label}](${item.href})` : label;
    } else if (item.type === "pageMention") {
      out += `[[page ${item.props?.pageId ?? "?"}]]`;
    } else if (Array.isArray(item.content)) out += inlineText(item.content);
  }
  return out;
}

/**
 * The app's `extractText`, mirrored: one whitespace-normalised blob for the
 * search index, capped so a huge transcript can't bloat the indexed field.
 */
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    if (!block) continue;
    const content = block.content;
    if (Array.isArray(content)) {
      out += inlineText(content) + " ";
    } else if (typeof content === "string") {
      out += content + " ";
    } else if (content && typeof content === "object" && Array.isArray(content.rows)) {
      for (const row of content.rows) {
        for (const cell of row.cells ?? []) out += inlineText(cell.content) + " ";
      }
    }
    if (Array.isArray(block.children) && block.children.length) {
      out += extractText(block.children) + " ";
    }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_TEXT);
}

/**
 * Stored blocks → Markdown, for reading a page back to the model. Lossy by
 * design (styles are dropped); page links keep their id so the model can
 * follow them with `vellum_read_page`.
 */
export function blocksToMarkdown(blocks, depth = 0) {
  if (!Array.isArray(blocks)) return "";
  const indent = "  ".repeat(depth);
  const lines = [];
  let numbered = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    const props = block.props ?? {};
    const text = typeof block.content === "string" ? block.content : inlineText(block.content);
    if (type !== "numberedListItem") numbered = 0;
    switch (type) {
      case "heading":
        lines.push(`${indent}${"#".repeat(Math.min(3, Number(props.level) || 1))} ${text}`);
        break;
      case "bulletListItem":
        lines.push(`${indent}- ${text}`);
        break;
      case "numberedListItem":
        numbered += 1;
        lines.push(`${indent}${numbered}. ${text}`);
        break;
      case "checkListItem":
        lines.push(`${indent}- [${props.checked ? "x" : " "}] ${text}`);
        break;
      case "quote":
        lines.push(`${indent}> ${text}`);
        break;
      case "codeBlock":
        lines.push(`${indent}\`\`\`${props.language ?? ""}`);
        lines.push(text);
        lines.push(`${indent}\`\`\``);
        break;
      case "table": {
        const rows = block.content?.rows ?? [];
        rows.forEach((row, ri) => {
          const cells = (row.cells ?? []).map((c) => inlineText(c.content).trim());
          lines.push(`${indent}| ${cells.join(" | ")} |`);
          if (ri === 0) lines.push(`${indent}| ${cells.map(() => "---").join(" | ")} |`);
        });
        break;
      }
      case "image":
      case "file":
      case "video":
      case "audio":
        lines.push(`${indent}[${type}: ${props.name || props.url || ""}]`);
        break;
      case "pageLink":
        lines.push(`${indent}[[page ${props.pageId ?? "?"}]]`);
        break;
      case "equation":
        lines.push(`${indent}$$${props.latex ?? ""}$$`);
        break;
      case "callout":
        lines.push(`${indent}> ${props.emoji ? props.emoji + " " : ""}${text}`);
        break;
      case "embed":
      case "bookmark":
        lines.push(`${indent}${props.url ?? props.title ?? ""}`);
        break;
      default:
        if (text) lines.push(`${indent}${text}`);
    }
    if (Array.isArray(block.children) && block.children.length) {
      const nested = blocksToMarkdown(block.children, depth + 1);
      if (nested) lines.push(nested);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
