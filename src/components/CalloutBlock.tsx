import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";

/**
 * A Notion-style callout: a tinted box with an emoji and editable rich-text
 * content. The emoji button opens a small popover to change the icon and
 * the background color.
 */

export const CALLOUT_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

const EMOJI_PRESETS = ["💡", "📌", "⚠️", "✅", "❗", "ℹ️", "🔥", "📝", "⭐", "🚀"];

export const CalloutSpec = createReactBlockSpec(
  {
    type: "callout" as const,
    propSchema: {
      icon: { default: "💡" },
      color: { default: "gray" },
    },
    content: "inline" as const,
  },
  {
    render: ({ block, editor, contentRef }) => {
      const icon = block.props.icon as string;
      const color = block.props.color as string;
      const [menuOpen, setMenuOpen] = useState(false);
      const wrapRef = useRef<HTMLDivElement>(null);

      useEffect(() => {
        if (!menuOpen) return;
        const onDocClick = (e: MouseEvent) => {
          if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        return () => document.removeEventListener("mousedown", onDocClick);
      }, [menuOpen]);

      const update = (patch: { icon?: string; color?: string }) => {
        editor.updateBlock(block, { props: patch } as never);
      };

      return (
        <div className={`callout-block callout-${color}`} data-color={color}>
          <div className="callout-emoji-wrap" ref={wrapRef} contentEditable={false}>
            <button
              className="callout-emoji"
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              title="Change icon & color"
            >
              {icon}
            </button>
            {menuOpen && (
              <div className="callout-menu">
                <div className="callout-menu-emojis">
                  {EMOJI_PRESETS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className={`callout-menu-emoji ${e === icon ? "active" : ""}`}
                      onClick={() => {
                        update({ icon: e });
                        setMenuOpen(false);
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <div className="callout-menu-colors">
                  {CALLOUT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`callout-swatch callout-${c} ${c === color ? "active" : ""}`}
                      title={c}
                      onClick={() => {
                        update({ color: c });
                        setMenuOpen(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="callout-content" ref={contentRef} />
        </div>
      );
    },
  },
);
