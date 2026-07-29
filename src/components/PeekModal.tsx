import { Maximize2, X } from "lucide-react";
import Modal from "./ui/Modal";
import PageView from "./PageView";
import { PageId, PagesIndex } from "../lib/types";
import { useNav } from "../state";

/**
 * Notion's row "peek": open a database row in a centered overlay instead of
 * navigating away, with an escape hatch to the full page.
 *
 * Reuses PageView wholesale — the row property panel, editor, backlinks and
 * comments all behave exactly as they do full-page. Both the peeked editor
 * and the title field already flush on unmount and on `vellum:flush-edits`,
 * so an offline id-remap while a peek is open is handled by the existing
 * machinery.
 */
export default function PeekModal({
  pageId,
  index,
  onClose,
}: {
  pageId: PageId;
  index: PagesIndex;
  onClose: () => void;
}) {
  const { navigate } = useNav();
  return (
    <Modal onClose={onClose} className="peek-modal" top="6vh">
      <div className="peek-bar">
        <button
          className="btn subtle"
          onClick={() => {
            navigate(pageId);
            onClose();
          }}
        >
          <Maximize2 size={14} /> Open as full page
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="peek-body">
        <PageView pageId={pageId} index={index} />
      </div>
    </Modal>
  );
}
