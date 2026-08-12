import { createReactBlockSpec } from "@blocknote/react";
import { useState } from "react";
import { ExternalLink, Pencil, Play } from "lucide-react";
import { toEmbed } from "../lib/embeds";

/**
 * Notion's `/embed`: a live iframe for YouTube, Vimeo, Loom, Figma, Maps,
 * Spotify, Google Docs — or any other framable URL.
 *
 * Like the bookmark block, every bit of state lives in block props, so it
 * persists through the ordinary `updateContent` path: no schema change, no
 * outbox op, and it works offline (the iframe just won't load).
 *
 * The original URL is always kept and always reachable through the footer
 * link — plenty of sites refuse to be framed (X-Frame-Options / CSP) and
 * render blank, and there is no way to detect that from inside the page.
 */
export const EmbedSpec = createReactBlockSpec(
  {
    type: "embed" as const,
    propSchema: {
      url: { default: "" },
    },
    content: "none" as const,
  },
  {
    render: ({ block, editor }) => {
      const url = block.props.url as string;
      const [draft, setDraft] = useState("");
      const [editing, setEditing] = useState(false);

      const commit = (raw: string) => {
        if (!toEmbed(raw)) return;
        editor.updateBlock(block, { props: { url: raw.trim() } } as never);
        setEditing(false);
      };

      const info = url ? toEmbed(url) : null;

      if (!info) {
        return (
          <div className="embed-block empty" contentEditable={false}>
            <Play size={15} className="embed-empty-icon" />
            <input
              className="embed-input"
              placeholder="Paste a YouTube, Figma, Maps or other link…"
              value={draft}
              autoFocus={editing}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(draft);
                }
              }}
            />
            <button
              className="btn subtle"
              type="button"
              disabled={!toEmbed(draft)}
              onClick={() => commit(draft)}
            >
              Embed
            </button>
          </div>
        );
      }

      if (editing) {
        return (
          <div className="embed-block empty" contentEditable={false}>
            <Play size={15} className="embed-empty-icon" />
            <input
              className="embed-input"
              defaultValue={url}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(draft || url);
                }
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <button className="btn subtle" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        );
      }

      return (
        <div className="embed-block" contentEditable={false}>
          <div
            className="embed-frame"
            style={{ aspectRatio: String(info.aspect) }}
          >
            <iframe
              src={info.src}
              title={`${info.provider} embed`}
              loading="lazy"
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen={info.allowFullscreen}
              // The frame renders untrusted third-party content: allow it to
              // run and navigate itself, but never to reach this document.
              // Known providers need allow-same-origin for their players;
              // the arbitrary-URL fallback must NOT get it — with
              // allow-scripts it voids the sandbox, and /p/* is proxied
              // onto this very origin.
              sandbox={
                info.known === false
                  ? "allow-scripts allow-presentation allow-popups allow-forms"
                  : "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms"
              }
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
          <div className="embed-foot">
            <span className="embed-provider">{info.provider}</span>
            <span className="embed-actions">
              <button
                className="icon-btn small"
                type="button"
                title="Change URL"
                onClick={() => {
                  setDraft(url);
                  setEditing(true);
                }}
              >
                <Pencil size={13} />
              </button>
              <a
                className="icon-btn small"
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Open original"
              >
                <ExternalLink size={13} />
              </a>
            </span>
          </div>
        </div>
      );
    },
  },
);
