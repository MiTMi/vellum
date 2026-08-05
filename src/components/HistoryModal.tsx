import { useEffect, useState } from "react";
import { History, RotateCcw, Loader2 } from "lucide-react";
import Modal from "./ui/Modal";
import { PageMeta, VersionDoc, VersionMeta } from "../lib/types";
import { useMutations, useVersionHistory } from "../data";
import { blocksToPlainText, extractText } from "../lib/blocks";
import { getActiveEditorFor } from "../lib/editorRegistry";
import {
  decryptJson,
  decryptTitle,
  isEncryptedContent,
  isEncryptedTitle,
} from "../lib/vaultCrypto";
import { displayTitle, vaultKey } from "../lib/vaultSession";

/**
 * Vault snapshots are stored as ciphertext (title and content alike).
 * Decrypt before showing or restoring — restore especially: handing the
 * envelope back to updateContent would make the wrapper encrypt it twice.
 */
async function decryptVersion(doc: VersionDoc): Promise<VersionDoc> {
  const out = { ...doc };
  if (isEncryptedTitle(out.title)) {
    out.title = await decryptTitle(vaultKey(), out.title);
  }
  if (isEncryptedContent(out.content)) {
    out.content = await decryptJson(vaultKey(), out.content);
  }
  return out;
}

/**
 * Notion-style page history: a list of snapshots on the left, a read-only
 * preview of the selected one on the right, and a restore button.
 *
 * Restoring goes through the ordinary `updateContent` mutation, so it flows
 * replica → outbox → server like any edit and wins by last-writer-wins.
 * Because updateContent snapshots the *previous* content first, restoring is
 * itself undoable — same as Notion.
 */
export default function HistoryModal({
  page,
  onClose,
}: {
  page: PageMeta;
  onClose: () => void;
}) {
  const history = useVersionHistory();
  const mutations = useMutations();
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VersionDoc | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    history
      .list(page._id)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        setSelectedId(rows[0]?._id ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load page history.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page._id]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    history
      .get(selectedId)
      .then(async (doc) => {
        const plain = doc ? await decryptVersion(doc) : doc;
        if (!cancelled) setDetail(plain);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load that version.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const restore = async () => {
    if (!detail) return;
    setRestoring(true);
    const blocks = (detail.content ?? []) as unknown[];
    await mutations.updateContent({
      id: page._id,
      content: blocks,
      text: extractText(blocks),
    });
    // BlockNote owns its document once mounted and never re-reads the
    // replica, so persisting alone would leave the open page showing the
    // pre-restore text (and its next debounced save would undo the
    // restore). Repaint it — only if it's still showing this page.
    const editor = getActiveEditorFor(page._id);
    if (editor && blocks.length) {
      editor.replaceBlocks(editor.document, blocks);
    }
    setRestoring(false);
    onClose();
  };

  return (
    <Modal onClose={onClose} className="history-modal" top="10vh">
      <div className="history-head">
        <History size={15} />
        <span>Page history</span>
        <span className="history-page-title">{displayTitle(page) || "Untitled"}</span>
      </div>
      <div className="history-body">
        <div className="history-list">
          {versions === null && !error && (
            <div className="history-empty">Loading…</div>
          )}
          {versions?.length === 0 && (
            <div className="history-empty">
              No earlier versions yet. Vellum saves one every few minutes while
              you edit.
            </div>
          )}
          {versions?.map((v) => (
            <button
              key={v._id}
              className={`history-item ${v._id === selectedId ? "selected" : ""}`}
              onClick={() => setSelectedId(v._id)}
            >
              <span className="history-when">{formatWhen(v.savedAt)}</span>
              <span className="history-title">
                {isEncryptedTitle(v.title) ? "🔒 Encrypted" : v.title || "Untitled"}
              </span>
            </button>
          ))}
        </div>
        <div className="history-preview">
          {error && <div className="history-empty">{error}</div>}
          {!error && loadingDetail && (
            <div className="history-empty">
              <Loader2 size={15} className="spin" /> Loading version…
            </div>
          )}
          {!error && !loadingDetail && detail && (
            <>
              <pre className="history-preview-text">
                {blocksToPlainText(detail.content) || "(empty page)"}
              </pre>
              <div className="history-actions">
                <button
                  className="btn primary"
                  disabled={restoring}
                  onClick={() => void restore()}
                >
                  <RotateCcw size={14} />
                  {restoring ? "Restoring…" : "Restore this version"}
                </button>
              </div>
            </>
          )}
          {!error && !loadingDetail && !detail && versions?.length !== 0 && (
            <div className="history-empty">Select a version to preview it.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)} h ago`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
