import React, { useRef, useState } from "react";
import Popover from "./ui/Popover";
import { COVER_GRADIENTS } from "../lib/colors";
import { useFileUpload } from "../data";

interface CoverPickerProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (cover: string | null) => void;
  /** False on Vault pages: uploaded covers are storage blobs the vault's
   *  encryption never touches, so only gradient covers are offered. */
  allowUpload?: boolean;
}

export default function CoverPicker({ anchor, onClose, onPick, allowUpload = true }: CoverPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useFileUpload();
  const [uploading, setUploading] = useState(false);

  return (
    <Popover anchor={anchor} onClose={onClose} className="cover-picker" width={324} align="right">
      <div className="cover-picker-section">Gallery</div>
      <div className="cover-grid">
        {COVER_GRADIENTS.map((g, i) => (
          <button
            key={i}
            className="cover-swatch"
            style={{ background: g }}
            onClick={() => {
              onPick(`gradient:${i}`);
              onClose();
            }}
          />
        ))}
      </div>
      <div className="cover-picker-section">{allowUpload ? "Upload" : "Options"}</div>
      <div className="cover-picker-actions">
        {allowUpload && (
          <button
            className="btn"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "Uploading…" : "Upload image"}
          </button>
        )}
        <button
          className="btn subtle"
          onClick={() => {
            onPick(null);
            onClose();
          }}
        >
          Remove cover
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setUploading(true);
          try {
            const url = await upload(file);
            onPick(url);
            onClose();
          } finally {
            setUploading(false);
          }
        }}
      />
    </Popover>
  );
}
