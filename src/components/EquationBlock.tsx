import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * Notion's block equation: KaTeX-rendered display math. Clicking the block
 * opens an inline LaTeX editor with a live preview.
 *
 * The LaTeX source lives in block props, so it persists through the ordinary
 * `updateContent` path — no schema change, no outbox op. It contains no page
 * ids, so id remapping and coalescing are unaffected.
 */

function renderInto(el: HTMLElement | null, latex: string) {
  if (!el) return;
  try {
    katex.render(latex, el, {
      throwOnError: false,
      displayMode: true,
      output: "html",
    });
  } catch {
    // katex already swallows most errors via throwOnError:false; this is the
    // belt-and-braces path so a bad expression can't blank the editor.
    el.textContent = latex;
  }
}

export const EquationSpec = createReactBlockSpec(
  {
    type: "equation" as const,
    propSchema: {
      latex: { default: "" },
    },
    content: "none" as const,
  },
  {
    render: ({ block, editor }) => {
      const latex = block.props.latex as string;
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState(latex);
      const outRef = useRef<HTMLDivElement>(null);
      const previewRef = useRef<HTMLDivElement>(null);

      useEffect(() => {
        if (!editing) renderInto(outRef.current, latex);
      }, [latex, editing]);

      useEffect(() => {
        if (editing) renderInto(previewRef.current, draft);
      }, [draft, editing]);

      const commit = () => {
        setEditing(false);
        if (draft !== latex) {
          editor.updateBlock(block, { props: { latex: draft } } as never);
        }
      };

      if (editing) {
        return (
          <div className="equation-block editing" contentEditable={false}>
            <div className="equation-preview" ref={previewRef} />
            <textarea
              className="equation-input"
              autoFocus
              value={draft}
              placeholder="E = mc^2"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                // Enter commits; Shift+Enter keeps multi-line LaTeX possible.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commit();
                }
                if (e.key === "Escape") {
                  setDraft(latex);
                  setEditing(false);
                }
              }}
            />
          </div>
        );
      }

      return (
        <div
          className={`equation-block ${latex ? "" : "empty"}`}
          contentEditable={false}
          onClick={() => {
            setDraft(latex);
            setEditing(true);
          }}
        >
          {latex ? (
            <div className="equation-render" ref={outRef} />
          ) : (
            <span className="equation-placeholder">
              Click to add an equation (LaTeX)
            </span>
          )}
        </div>
      );
    },
  },
);
