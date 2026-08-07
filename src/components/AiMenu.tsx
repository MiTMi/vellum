import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles,
  Wand2,
  SpellCheck,
  Minimize2,
  Maximize2,
  FileText,
  List,
  Languages,
  Mic,
  CornerDownLeft,
  Check,
  RotateCcw,
  X,
  Loader2,
} from "lucide-react";
import { AiTransformKind } from "../lib/types";
import { useAi } from "../data";

/**
 * Notion's "Ask AI" menu over a text selection.
 *
 * Built as a portalled overlay rather than a BlockNote formatting-toolbar
 * extension, for the same reason as CodeCopyOverlay and BlockAnchorOverlay:
 * injecting into ProseMirror's own chrome is fragile across BlockNote
 * upgrades, and this way the whole preview/apply/discard flow is ours.
 *
 * The flow mirrors Notion's: run an action → show the result in a preview
 * card → Replace / Insert below / Discard / Try again. Nothing touches the
 * document until the user accepts, so a bad generation costs one click.
 */

const TONES = ["Professional", "Casual", "Confident", "Friendly", "Direct"];
const LANGUAGES = [
  "English",
  "French",
  "Spanish",
  "German",
  "Hebrew",
  "Italian",
  "Portuguese",
  "Japanese",
];

interface Action {
  kind: AiTransformKind;
  label: string;
  icon: React.ReactNode;
  /** Opens a submenu of options (tone, language) rather than running. */
  submenu?: string[];
}

const ACTIONS: Action[] = [
  { kind: "improve", label: "Improve writing", icon: <Wand2 size={15} /> },
  { kind: "fix", label: "Fix spelling & grammar", icon: <SpellCheck size={15} /> },
  { kind: "shorter", label: "Make shorter", icon: <Minimize2 size={15} /> },
  { kind: "longer", label: "Make longer", icon: <Maximize2 size={15} /> },
  { kind: "summarize", label: "Summarize", icon: <FileText size={15} /> },
  { kind: "bullets", label: "Turn into bullets", icon: <List size={15} /> },
  { kind: "tone", label: "Change tone", icon: <Mic size={15} />, submenu: TONES },
  {
    kind: "translate",
    label: "Translate",
    icon: <Languages size={15} />,
    submenu: LANGUAGES,
  },
  { kind: "continue", label: "Continue writing", icon: <CornerDownLeft size={15} /> },
];

export interface AiMenuProps {
  /** The editor wrapper the menu portals into (position: relative). */
  container: HTMLElement | null;
  /** Selected text to operate on. Empty means "continue writing" only. */
  selection: string;
  /**
   * Document text preceding the caret. Used only by "Continue writing" with
   * no selection — otherwise it has nothing to continue from.
   */
  context: string;
  /** Where to anchor, relative to `container`. */
  position: { top: number; left: number };
  onClose: () => void;
  /** Replace the selection with the generated text. */
  onReplace: (text: string) => void;
  /** Insert the generated text as new blocks below the selection. */
  onInsertBelow: (text: string) => void;
}

export default function AiMenu({
  container,
  selection,
  context,
  position,
  onClose,
  onReplace,
  onInsertBelow,
}: AiMenuProps) {
  const ai = useAi();
  const [submenu, setSubmenu] = useState<Action | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Remembered so "Try again" re-runs the same operation. */
  const lastRun = useRef<{ kind: AiTransformKind; option?: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes; clicking outside closes. Both are captured on the
  // document because the menu lives in a portal outside the editor's tree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const run = async (kind: AiTransformKind, option?: string) => {
    lastRun.current = { kind, option };
    setBusy(true);
    setError(null);
    setSubmenu(null);
    try {
      const text = await ai.transform({
        // "Continue writing" produces a continuation rather than a rewrite,
        // so with no selection it operates on the preceding document text.
        // A free-form instruction on a blank line is a write-from-scratch
        // request and correctly sends nothing.
        text: kind === "continue" && !selection.trim() ? context : selection,
        kind,
        option,
      });
      setResult(text);
    } catch (err) {
      // Convex surfaces ConvexError's payload as `.data`; everything else
      // falls back to the message. Both are already user-facing strings.
      const data = (err as { data?: unknown }).data;
      setError(
        typeof data === "string"
          ? data
          : err instanceof Error
            ? err.message
            : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!container) return null;

  const body = (
    <div
      ref={rootRef}
      className="ai-menu"
      style={{ position: "absolute", top: position.top, left: position.left }}
      // Keep the editor selection alive while interacting with the menu.
      onMouseDown={(e) => e.preventDefault()}
    >
      {result === null ? (
        <>
          <div className="ai-menu-input">
            <Sparkles size={15} className="ai-menu-spark" />
            <input
              ref={inputRef}
              value={custom}
              placeholder={
                busy ? "Working…" : "Ask AI to edit or write anything…"
              }
              disabled={busy}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom.trim() && !busy) {
                  e.preventDefault();
                  void run("custom", custom.trim());
                }
              }}
            />
            {busy && <Loader2 size={15} className="ai-spin" />}
          </div>

          {error && <div className="ai-menu-error">{error}</div>}

          {!busy && (
            <div className="ai-menu-list">
              {submenu ? (
                <>
                  <button
                    className="ai-menu-item ai-menu-back"
                    onClick={() => setSubmenu(null)}
                  >
                    ← {submenu.label}
                  </button>
                  {submenu.submenu?.map((opt) => (
                    <button
                      key={opt}
                      className="ai-menu-item"
                      onClick={() => void run(submenu.kind, opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </>
              ) : (
                ACTIONS.filter(
                  // Everything except "Continue writing" needs a selection.
                  (a) => selection.trim() !== "" || a.kind === "continue",
                ).map((a) => (
                  <button
                    key={a.kind}
                    className="ai-menu-item"
                    onClick={() =>
                      a.submenu ? setSubmenu(a) : void run(a.kind)
                    }
                  >
                    <span className="ai-menu-icon">{a.icon}</span>
                    {a.label}
                    {a.submenu && <span className="ai-menu-chev">›</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="ai-menu-result">{result}</div>
          <div className="ai-menu-actions">
            {selection.trim() !== "" && (
              <button
                className="ai-menu-item"
                onClick={() => {
                  onReplace(result);
                  onClose();
                }}
              >
                <span className="ai-menu-icon">
                  <Check size={15} />
                </span>
                Replace selection
              </button>
            )}
            <button
              className="ai-menu-item"
              onClick={() => {
                onInsertBelow(result);
                onClose();
              }}
            >
              <span className="ai-menu-icon">
                <CornerDownLeft size={15} />
              </span>
              Insert below
            </button>
            <button
              className="ai-menu-item"
              onClick={() => {
                const last = lastRun.current;
                setResult(null);
                if (last) void run(last.kind, last.option);
              }}
            >
              <span className="ai-menu-icon">
                <RotateCcw size={15} />
              </span>
              Try again
            </button>
            <button className="ai-menu-item ai-menu-danger" onClick={onClose}>
              <span className="ai-menu-icon">
                <X size={15} />
              </span>
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(body, container);
}
