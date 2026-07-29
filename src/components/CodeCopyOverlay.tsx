import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Check } from "lucide-react";

/**
 * Floating "copy" button for code blocks. BlockNote renders code blocks as
 * [data-content-type="codeBlock"] elements inside the editor; injecting DOM
 * into ProseMirror content is fragile, so instead we track the hovered code
 * block and position a button over its top-right corner.
 *
 * The button is portaled into the editor wrapper (not document.body) and
 * positioned absolutely — that way hovering the button still counts as
 * hovering the editor, so it can't dismiss itself under the cursor.
 */
export default function CodeCopyOverlay({
  container,
}: {
  container: HTMLElement | null;
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
        top: blockRect.top - wrapRect.top + 8,
        left: blockRect.right - wrapRect.left - 36,
      });
    };

    const show = (el: HTMLElement) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setTarget(el);
      place(el);
    };

    const scheduleHide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        setTarget(null);
        setCopied(false);
      }, 200);
    };

    const onMove = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (btnRef.current?.contains(t)) {
        // Hovering the button itself — keep it alive.
        if (hideTimer.current) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        return;
      }
      const el = t.closest?.('[data-content-type="codeBlock"]') as HTMLElement | null;
      if (el) show(el);
      else scheduleHide();
    };
    const onLeave = () => scheduleHide();

    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [container]);

  // Re-anchor if layout shifts while visible (typing, window resize).
  useEffect(() => {
    if (!target || !container) return;
    const update = () => {
      if (!document.contains(target)) {
        setTarget(null);
        return;
      }
      const blockRect = target.getBoundingClientRect();
      const wrapRect = container.getBoundingClientRect();
      setPos({
        top: blockRect.top - wrapRect.top + 8,
        left: blockRect.right - wrapRect.left - 36,
      });
    };
    window.addEventListener("resize", update);
    const interval = setInterval(update, 500); // cheap safety net for edits
    return () => {
      window.removeEventListener("resize", update);
      clearInterval(interval);
    };
  }, [target, container]);

  if (!container || !target || !pos) return null;

  const copy = async () => {
    const code =
      target.querySelector("pre, code")?.textContent ?? target.textContent ?? "";
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  return createPortal(
    <button
      ref={btnRef}
      className={`code-copy-btn ${copied ? "copied" : ""}`}
      style={{ position: "absolute", top: pos.top, left: pos.left }}
      title="Copy code"
      onMouseDown={(e) => e.preventDefault()} // don't steal editor focus
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>,
    container,
  );
}
