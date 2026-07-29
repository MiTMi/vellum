import { createReactBlockSpec } from "@blocknote/react";
import { useState } from "react";
import { Link2, Loader2, RefreshCw } from "lucide-react";
import { hostLabel, normalizeUrl } from "../../convex/lib/linkMeta";
import { fetchLinkPreview } from "../lib/linkPreviewRegistry";

/**
 * Notion's "Web bookmark": paste a URL and get a card with the page's Open
 * Graph title, description and image.
 *
 * Metadata is fetched through a Convex action (the renderer can't fetch
 * arbitrary origins), but the block never depends on it: an empty or failed
 * fetch still renders a usable link card showing the hostname, with a retry.
 * All state lives in block props, so persistence rides the normal
 * `updateContent` path — no schema change, no outbox op.
 */
export const BookmarkSpec = createReactBlockSpec(
  {
    type: "bookmark" as const,
    propSchema: {
      url: { default: "" },
      title: { default: "" },
      description: { default: "" },
      image: { default: "" },
    },
    content: "none" as const,
  },
  {
    render: ({ block, editor }) => {
      const url = block.props.url as string;
      const title = block.props.title as string;
      const description = block.props.description as string;
      const image = block.props.image as string;

      const [draft, setDraft] = useState("");
      const [loading, setLoading] = useState(false);

      const update = (patch: Record<string, string>) =>
        editor.updateBlock(block, { props: patch } as never);

      const load = async (raw: string) => {
        const normalized = normalizeUrl(raw);
        if (!normalized) return;
        // Commit the URL first so the card survives a failed fetch.
        update({ url: normalized });
        setLoading(true);
        const meta = await fetchLinkPreview(normalized);
        setLoading(false);
        if (meta) {
          update({
            url: meta.url || normalized,
            title: meta.title,
            description: meta.description,
            image: meta.image,
          });
        }
      };

      if (!url) {
        return (
          <div className="bookmark-block empty" contentEditable={false}>
            <Link2 size={15} className="bookmark-empty-icon" />
            <input
              className="bookmark-input"
              placeholder="Paste a link…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void load(draft);
                }
              }}
            />
            <button
              className="btn subtle"
              type="button"
              disabled={!normalizeUrl(draft)}
              onClick={() => void load(draft)}
            >
              Create bookmark
            </button>
          </div>
        );
      }

      const host = hostLabel(url);
      return (
        <div className="bookmark-block" contentEditable={false}>
          <a
            className="bookmark-card"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            <div className="bookmark-text">
              <div className="bookmark-title">{title || host}</div>
              {description && (
                <div className="bookmark-desc">{description}</div>
              )}
              <div className="bookmark-host">
                <Link2 size={12} />
                {host}
              </div>
            </div>
            {image && (
              <div
                className="bookmark-image"
                style={{ backgroundImage: `url("${image}")` }}
              />
            )}
          </a>
          <button
            className="icon-btn small bookmark-refresh"
            type="button"
            title={loading ? "Fetching…" : "Refresh preview"}
            disabled={loading}
            onClick={() => void load(url)}
          >
            {loading ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <RefreshCw size={13} />
            )}
          </button>
        </div>
      );
    },
  },
);
