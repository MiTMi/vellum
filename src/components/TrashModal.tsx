import React, { useState } from "react";
import { Trash2, RotateCcw, FileText, Database, X } from "lucide-react";
import Modal from "./ui/Modal";
import { useMutations, useTrashed } from "../data";
import { useNav } from "../state";

export default function TrashModal({ onClose }: { onClose: () => void }) {
  const trashed = useTrashed();
  const mutations = useMutations();
  const { navigate } = useNav();
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <Modal onClose={onClose} className="trash-modal" top="16vh">
      <div className="trash-head">
        <span className="trash-title">
          <Trash2 size={16} /> Trash
        </span>
        {(trashed?.length ?? 0) > 0 && (
          <button
            className="btn subtle danger"
            onClick={() => {
              if (confirming === "__all") {
                void mutations.emptyTrash();
                setConfirming(null);
              } else {
                setConfirming("__all");
              }
            }}
          >
            {confirming === "__all" ? "Click again to confirm" : "Empty trash"}
          </button>
        )}
        <button className="icon-btn" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="trash-list">
        {(trashed ?? []).map((p) => (
          <div key={p._id} className="trash-row">
            <span className="tree-icon">
              {p.icon ? (
                p.icon
              ) : p.type === "database" ? (
                <Database size={15} />
              ) : (
                <FileText size={15} />
              )}
            </span>
            <span className="tree-title">{p.title || "Untitled"}</span>
            <span className="trash-date">
              {new Date(p.trashedAt).toLocaleDateString()}
            </span>
            <button
              className="icon-btn"
              title="Restore"
              onClick={async () => {
                await mutations.restore({ id: p._id });
                navigate(p._id);
                onClose();
              }}
            >
              <RotateCcw size={15} />
            </button>
            <button
              className={`icon-btn ${confirming === p._id ? "danger-solid" : ""}`}
              title={confirming === p._id ? "Click again to delete forever" : "Delete forever"}
              onClick={() => {
                if (confirming === p._id) {
                  void mutations.deleteForever({ id: p._id });
                  setConfirming(null);
                } else {
                  setConfirming(p._id);
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {(trashed?.length ?? 0) === 0 && (
          <div className="trash-empty">Trash is empty</div>
        )}
      </div>
    </Modal>
  );
}
