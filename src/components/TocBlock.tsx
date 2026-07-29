import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useState } from "react";

/**
 * A Notion-style table of contents. Reads the page's heading blocks live
 * and renders indented, clickable links that scroll to each heading.
 * Content-less block: it derives everything from the document.
 */

interface Heading {
  id: string;
  text: string;
  level: number;
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (item && typeof item === "object") {
      const anyItem = item as Record<string, unknown>;
      if (typeof anyItem.text === "string") out += anyItem.text;
      else if (Array.isArray(anyItem.content)) out += inlineText(anyItem.content);
    }
  }
  return out;
}

export const TocSpec = createReactBlockSpec(
  {
    type: "toc" as const,
    propSchema: {},
    content: "none" as const,
  },
  {
    render: ({ editor }) => {
      const [headings, setHeadings] = useState<Heading[]>([]);

      useEffect(() => {
        const collect = () => {
          const out: Heading[] = [];
          for (const block of editor.document as Array<{
            id: string;
            type: string;
            props?: Record<string, unknown>;
            content?: unknown;
          }>) {
            if (block.type === "heading") {
              const level = Number(block.props?.level ?? 1);
              const text = inlineText(block.content).trim();
              out.push({ id: block.id, text, level });
            }
          }
          setHeadings(out);
        };
        collect();
        return editor.onChange(collect) as undefined | (() => void);
      }, [editor]);

      const jumpTo = (id: string) => {
        const el = document.querySelector(`[data-id="${id}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      };

      const minLevel = headings.reduce(
        (m, h) => Math.min(m, h.level),
        Infinity,
      );

      return (
        <div className="toc-block" contentEditable={false}>
          {headings.length === 0 ? (
            <div className="toc-empty">
              Add headings to the page to build a table of contents.
            </div>
          ) : (
            headings.map((h, i) => (
              <button
                key={h.id + i}
                type="button"
                className="toc-item"
                style={{ paddingLeft: 4 + (h.level - minLevel) * 18 }}
                onClick={() => jumpTo(h.id)}
              >
                {h.text || "Untitled heading"}
              </button>
            ))
          )}
        </div>
      );
    },
  },
);
