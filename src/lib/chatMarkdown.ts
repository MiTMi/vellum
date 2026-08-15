/**
 * Markdown → typed display tree for the AI chat panel.
 *
 * `markdownBlocks.ts` deliberately drops inline styling because its output
 * becomes *page content* — a mis-parse there corrupts what gets saved.
 * Chat is the opposite trade: the text is ephemeral display, and models
 * lean hard on **bold**, `code`, fences and lists, so unrendered markers
 * read as garbage. This stays a hand-written parser (the formula.ts rule:
 * model/user input never meets eval or innerHTML) and returns a tree the
 * ChatMarkdown component maps onto real React elements — no HTML strings
 * anywhere, so nothing the model emits can become markup.
 *
 * Line-oriented like its sibling: headings, list items, quotes, rules,
 * fenced code, paragraphs; inline code/bold/italic/links inside them.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type ChatBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inline: InlineNode[] }
  | { kind: "paragraph"; inline: InlineNode[] }
  | { kind: "quote"; inline: InlineNode[] }
  | { kind: "bullets"; items: InlineNode[][] }
  | { kind: "numbered"; items: InlineNode[][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

/**
 * Inline tokenizer. One combined scan, code spans first so markers inside
 * them stay literal. Underscore italics require non-word neighbours —
 * snake_case identifiers are everyday chat content and must not italicize.
 * Links only keep http(s) targets; anything else renders as plain text.
 */
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|((?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))|(\[[^\]\n]+\]\([^\s)]+\))/g;

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push({ kind: "text", text: text.slice(last, idx) });
    const tok = m[0];
    if (m[1]) {
      nodes.push({ kind: "code", text: tok.slice(1, -1) });
    } else if (m[2]) {
      nodes.push({ kind: "bold", text: tok.slice(2, -2) });
    } else if (m[3] || m[4]) {
      nodes.push({ kind: "italic", text: tok.slice(1, -1) });
    } else {
      const link = tok.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      if (link && /^https?:\/\//i.test(link[2])) {
        nodes.push({ kind: "link", text: link[1], href: link[2] });
      } else {
        // Non-http target (javascript:, relative, …): show the label only.
        nodes.push({ kind: "text", text: link ? link[1] : tok });
      }
    }
    last = idx + tok.length;
  }
  if (last < text.length) nodes.push({ kind: "text", text: text.slice(last) });
  // Merge adjacent text nodes (a demoted link leaves one behind its tail).
  return nodes.reduce<InlineNode[]>((out, n) => {
    const prev = out[out.length - 1];
    if (n.kind === "text" && prev?.kind === "text") prev.text += n.text;
    else out.push(n);
    return out;
  }, []);
}

export function parseChatMarkdown(markdown: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Fenced code: swallow to the closing fence (or the end — models get
    // cut off mid-fence and the tail must still render as code).
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "code", text: buf.join("\n") });
      continue;
    }

    let m: RegExpMatchArray | null;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push({ kind: "rule" });
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push({
        kind: "heading",
        level: Math.min(m[1].length, 3) as 1 | 2 | 3,
        inline: parseInline(m[2].trim()),
      });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ kind: "quote", inline: parseInline(m[1].trim()) });
    } else if ((m = line.match(/^[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/))) {
      // Checklist markers render as list items — chat is read-only, so a
      // live checkbox would only promise interactivity that isn't there.
      const item = parseInline(
        (m[1] ? `${m[1].toLowerCase() === "x" ? "☑" : "☐"} ` : "") + m[2].trim(),
      );
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "bullets") prev.items.push(item);
      else blocks.push({ kind: "bullets", items: [item] });
    } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      const item = parseInline(m[1].trim());
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "numbered") prev.items.push(item);
      else blocks.push({ kind: "numbered", items: [item] });
    } else {
      blocks.push({ kind: "paragraph", inline: parseInline(line) });
    }
  }

  return blocks;
}
