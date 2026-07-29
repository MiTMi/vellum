import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  width?: number;
  maxHeight?: number;
  className?: string;
}

/**
 * Minimal popover: portals to <body>, positions itself under the anchor,
 * flips above when there is no room, closes on outside click / Escape.
 */
export default function Popover({
  anchor,
  onClose,
  children,
  align = "left",
  width,
  maxHeight = 420,
  className = "",
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Start position:fixed so the element shrink-wraps its content — measuring
  // offsetWidth while statically positioned reports the full body width and
  // right-aligned popovers end up clamped to the left edge.
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const el = ref.current;
    const w = width ?? el.offsetWidth;
    const h = Math.min(el.offsetHeight, maxHeight);

    let left =
      align === "right"
        ? a.right - w
        : align === "center"
          ? a.left + a.width / 2 - w / 2
          : a.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

    let top = a.bottom + 6;
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, a.top - h - 6);
    }
    setStyle({
      position: "fixed",
      top,
      left,
      width: width ? width : undefined,
      maxHeight,
      zIndex: 1000,
    });
  }, [anchor, align, width, maxHeight]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        anchor &&
        !anchor.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, anchor]);

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={style}>
      {children}
    </div>,
    document.body,
  );
}
