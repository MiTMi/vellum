import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import "katex/dist/katex.min.css";
import { warmChunk } from "../lib/warmChunk";

/**
 * Notion's block equation: KaTeX-rendered display math. Clicking the block
 * opens an inline LaTeX editor with a live preview.
 *
 * The LaTeX source lives in block props, so it persists through the ordinary
 * `updateContent` path — no schema change, no outbox op. It contains no page
 * ids, so id remapping and coalescing are unaffected.
 */

/*
 * KaTeX's JavaScript (~270 kB, a seventh of the old entry chunk) loads on
 * demand; most pages never show an equation. Only the library is lazy — the
 * block spec stays registered synchronously (stored documents must parse on
 * first mount) and the stylesheet stays a static import: moved into the lazy
 * chunk it would load AFTER app.css and flip the cascade against the
 * `.katex-display` override there, and a lazy chunk that carries CSS is a
 * mechanism never exercised under Electron's file://. Script-only lazy
 * chunks are (the emoji picker).
 *
 * What keeps it invisible:
 *  - the chunk is warmed shortly after boot (warmChunk), and fetched at once
 *    by any equation block that mounts, so it is resident long before anyone
 *    can type LaTeX or open the export menu;
 *  - once resident, rendering is SYNCHRONOUS, exactly as before. That is not
 *    an optimisation: BlockNote exports a custom block by rendering it under
 *    flushSync and cloning the DOM at once, so an always-async render would
 *    silently blank every equation in HTML/PDF exports;
 *  - the PWA plugin precaches every emitted chunk, so it works offline.
 */
type Katex = typeof import("katex").default;
let katexMod: Katex | null = null;
let katexLoading: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  // A failed load is terminal for this document: the browser memoizes a
  // failed module fetch, so re-running `import("katex")` would reject again
  // without a network request (see lib/lazyModule.ts). The rejection stays
  // cached here and renderInto falls back to showing the LaTeX source.
  return (katexLoading ??= import("katex").then((m) => (katexMod = m.default)));
}

warmChunk(loadKatex);

/** Returns a canceller: a load that resolves late must not paint a node
 *  that has since been given newer LaTeX, or unmounted. */
function renderInto(el: HTMLElement | null, latex: string): () => void {
  if (!el) return () => {};
  const paint = (katex: Katex) => {
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
  };
  if (katexMod) {
    paint(katexMod);
    return () => {};
  }
  let cancelled = false;
  loadKatex().then(
    (katex) => !cancelled && paint(katex),
    () => {
      // The library never arrived: show the source rather than nothing.
      if (!cancelled) el.textContent = latex;
    },
  );
  return () => {
    cancelled = true;
  };
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
    // Named, not an arrow: BlockNote mounts `render` as a component, and the
    // name is how react-hooks/rules-of-hooks knows to check the hooks below.
    render: function EquationBlockView({ block, editor }) {
      const latex = block.props.latex as string;
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState(latex);
      const outRef = useRef<HTMLDivElement>(null);
      const previewRef = useRef<HTMLDivElement>(null);

      // An empty block has nothing to render yet, but is about to.
      useEffect(() => void loadKatex().catch(() => {}), []);

      useEffect(() => {
        if (!editing) return renderInto(outRef.current, latex);
      }, [latex, editing]);

      useEffect(() => {
        if (editing) return renderInto(previewRef.current, draft);
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
