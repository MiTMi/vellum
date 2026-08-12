/**
 * Line-oriented Markdown → BlockNote partial blocks. The deck-outline
 * mapper from AiChatPanel, promoted to a tested helper and generalized:
 * headings (#/##/###), checklists, bullets, numbered lists, paragraphs.
 *
 * Deliberately not a full Markdown parser — model output for pages is
 * line-shaped, and BlockNote accepts plain strings as inline content, so
 * inline styling (bold/links) rides through as literal text rather than
 * risking a mis-parse of user-visible content.
 */

export interface PartialBlock {
  type: string;
  props?: Record<string, unknown>;
  content: string;
}

export function markdownToBlocks(markdown: string): {
  blocks: PartialBlock[];
  text: string;
} {
  const blocks: PartialBlock[] = [];
  const textParts: string[] = [];

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let block: PartialBlock;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      block = {
        type: "heading",
        props: { level: m[1].length },
        content: m[2].trim(),
      };
    } else if ((m = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      block = {
        type: "checkListItem",
        props: { checked: m[1].toLowerCase() === "x" },
        content: m[2].trim(),
      };
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      block = { type: "bulletListItem", content: m[1].trim() };
    } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      block = { type: "numberedListItem", content: m[1].trim() };
    } else {
      block = { type: "paragraph", content: line };
    }
    blocks.push(block);
    textParts.push(block.content);
  }

  return { blocks, text: textParts.join("\n") };
}
