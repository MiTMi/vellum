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
