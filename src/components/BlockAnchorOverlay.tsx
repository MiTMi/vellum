import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link2, Check } from "lucide-react";
import { anchorUrl } from "../lib/anchors";

/**
 * Notion's "Copy link to block": hovering any block reveals a small link
 * button that copies a deep link to it.
 *
 * Same overlay technique as CodeCopyOverlay — injecting DOM into ProseMirror
 * content is fragile, so the button is portaled into the editor wrapper and
 * positioned over the hovered block's left gutter (the right side already
 * belongs to the code-copy button).
 */
export default function BlockAnchorOverlay({
  container,
  pageId,
}: {
  container: HTMLElement | null;
  pageId: string;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!container) return;

    const place = (el: HTMLElement) => {
      const blockRect = el.getBoundingClientRect();
      const wrapRect = container.getBoundingClientRect();
      setPos({
        top: blockRect.top - wrapRect.top + 2,
        // In the right-hand margin, just outside the block. The left gutter
        // belongs to BlockNote's drag handle and "+" button — anything
        // placed there is covered by them and can't be clicked.
        left: blockRect.right - wrapRect.left + 6,
      });
    };

    const onMove = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (btnRef.current?.contains(t)) {
        if (hideTimer.current) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        return;
      }
      const el = t.closest?.("[data-id]") as HTMLElement | null;
      if (el?.dataset.id) {
        if (hideTimer.current) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        setTarget(el);
        place(el);
      } else if (!hideTimer.current) {
        hideTimer.current = setTimeout(() => {
          hideTimer.current = null;
          setTarget(null);
          setCopied(false);
        }, 200);
      }
    };
    const onLeave = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null;
        setTarget(null);
        setCopied(false);
      }, 200);
    };

    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [container]);

  if (!container || !target || !pos) return null;

  const copy = async () => {
    const blockId = target.dataset.id;
    if (!blockId) return;
    try {
      await navigator.clipboard.writeText(anchorUrl(pageId, blockId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  return createPortal(
    <button
      ref={btnRef}
      className={`block-anchor-btn ${copied ? "copied" : ""}`}
      style={{ position: "absolute", top: pos.top, left: pos.left }}
      title="Copy link to block"
      onMouseDown={(e) => e.preventDefault()} // don't steal editor focus
      onClick={() => void copy()}
    >
      {copied ? <Check size={13} /> : <Link2 size={13} />}
    </button>,
    container,
  );
}
