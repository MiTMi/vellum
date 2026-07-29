import React, { Suspense } from "react";
import Popover from "./ui/Popover";
import { useNav } from "../state";

const EmojiPicker = React.lazy(() => import("emoji-picker-react"));

interface IconPickerProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (emoji: string) => void;
  onRemove?: () => void;
}

export default function IconPicker({ anchor, onClose, onPick, onRemove }: IconPickerProps) {
  const { theme } = useNav();
  return (
    <Popover anchor={anchor} onClose={onClose} className="icon-picker" maxHeight={460}>
      {onRemove && (
        <div className="icon-picker-head">
          <button
            className="btn subtle"
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            Remove icon
          </button>
        </div>
      )}
      <Suspense fallback={<div className="icon-picker-loading">Loading…</div>}>
        <EmojiPicker
          onEmojiClick={(e: { emoji: string }) => {
            onPick(e.emoji);
            onClose();
          }}
          theme={theme as never}
          emojiStyle={"native" as never}
          width={340}
          height={400}
          previewConfig={{ showPreview: false } as never}
        />
      </Suspense>
    </Popover>
  );
}
