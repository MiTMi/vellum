import { useCallback, useEffect, useState } from "react";
import {
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Check,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { CommentMeta, PageId } from "../lib/types";
import { useComments } from "../data";

/**
 * Notion-style page comments, rendered under the editor next to "Linked
 * mentions".
 *
 * `list` is a plain callback rather than a reactive query (offline mode has
 * no ConvexProvider), so the panel refetches after each write and on page
 * change — the same approach HistoryModal takes.
 */
export default function Comments({ pageId }: { pageId: PageId }) {
  const api = useComments();
  const [items, setItems] = useState<CommentMeta[] | null>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const available = api.available;

  const refresh = useCallback(async () => {
    if (!available) {
      setItems(null);
      return;
    }
    try {
      setItems(await api.list(pageId));
    } catch {
      setItems([]);
    }
  }, [api, pageId, available]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    await api.add(pageId, text);
    await refresh();
    setBusy(false);
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    await refresh();
    setBusy(false);
  };

  // Nothing to show and nothing to add — stay out of the way entirely.
  if (!available && !items?.length) {
    return (
      <div className="comments">
        <div className="comments-header static">
          <MessageSquare size={13} />
          <span>Comments unavailable offline</span>
        </div>
      </div>
    );
  }

  const unresolved = (items ?? []).filter((c) => !c.resolved);

  return (
    <div className="comments">
      <button className="comments-header" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <MessageSquare size={13} />
        <span>
          {unresolved.length > 0
            ? `${unresolved.length} comment${unresolved.length === 1 ? "" : "s"}`
            : "Comments"}
        </span>
      </button>

      {open && (
        <>
          {(items ?? []).map((c) => (
            <div
              key={c._id}
              className={`comment-item ${c.resolved ? "resolved" : ""}`}
            >
              <div className="comment-body">
                <div className="comment-text">{c.text}</div>
                <div className="comment-when">{formatWhen(c.createdAt)}</div>
              </div>
              <div className="comment-actions">
                <button
                  className="icon-btn small"
                  title={c.resolved ? "Reopen" : "Resolve"}
                  onClick={() =>
                    void act(() => api.setResolved(c._id, !c.resolved))
                  }
                >
                  {c.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
                </button>
                <button
                  className="icon-btn small"
                  title="Delete comment"
                  onClick={() => void act(() => api.remove(c._id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}

          <div className="comment-compose">
            <input
              placeholder="Add a comment…"
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <button
              className="btn primary"
              disabled={!draft.trim() || busy}
              onClick={() => void submit()}
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatWhen(ts: number): string {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
