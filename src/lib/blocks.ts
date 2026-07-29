/** Extract plain text from a BlockNote document for full-text search. */

type AnyBlock = {
  type?: string;
  content?: unknown;
  children?: AnyBlock[];
};

function textFromInline(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (item && typeof item === "object") {
      const anyItem = item as Record<string, unknown>;
      if (typeof anyItem.text === "string") out += anyItem.text + " ";
      else if (Array.isArray(anyItem.content)) out += textFromInline(anyItem.content);
    }
  }
  return out;
}

/**
 * Line-per-block rendering of a document, for the page-history preview.
 * Unlike extractText (one search blob) this keeps block boundaries so an old
 * version reads like the page it was.
 */
export function blocksToPlainText(blocks: unknown, depth = 0): string {
  if (!Array.isArray(blocks)) return "";
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const block of blocks as AnyBlock[]) {
    if (!block) continue;
    const content = block.content;
    let line = Array.isArray(content) ? textFromInline(content).trim() : "";
    if (block.type === "bulletListItem") line = `• ${line}`;
    else if (block.type === "checkListItem") line = `☐ ${line}`;
    else if (block.type === "heading") line = line ? `# ${line}` : "";
    else if (block.type === "quote") line = line ? `❝ ${line}` : "";
    lines.push(indent + line);
    if (Array.isArray(block.children) && block.children.length) {
      lines.push(blocksToPlainText(block.children, depth + 1));
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000);
}

export function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks as AnyBlock[]) {
    if (!block) continue;
    const content = block.content as
      | unknown[]
      | { rows?: { cells: { content?: unknown }[] }[] }
      | undefined;
    if (Array.isArray(content)) {
      out += textFromInline(content);
    } else if (content && typeof content === "object" && Array.isArray(content.rows)) {
      for (const row of content.rows) {
        for (const cell of row.cells ?? []) {
          out += textFromInline((cell as { content?: unknown }).content);
        }
      }
    }
    if (Array.isArray(block.children) && block.children.length) {
      out += extractText(block.children);
    }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 8000);
}
