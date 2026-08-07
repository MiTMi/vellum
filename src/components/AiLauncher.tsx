import { Sparkles } from "lucide-react";
import { useAi } from "../data";

/**
 * The floating AI button in the bottom-right corner — Notion's persistent
 * entry point into the assistant, and the one affordance that makes AI
 * discoverable without knowing a shortcut.
 *
 * Hidden while the panel is open (the panel *is* the expanded state, so
 * leaving the bubble would just be a second control for the same thing) and
 * whenever AI is unavailable — offline, where every call is a live
 * round-trip with nothing to queue.
 */
export default function AiLauncher({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: () => void;
}) {
  const ai = useAi();
  if (open || !ai.available) return null;

  return (
    <button
      className="ai-launcher"
      title="Ask AI (⌘⇧J)"
      aria-label="Ask AI"
      onClick={onOpen}
    >
      <Sparkles size={20} />
    </button>
  );
}
