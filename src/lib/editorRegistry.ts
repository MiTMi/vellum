/**
 * The currently-mounted BlockNote editor, exposed so the top bar's Share
 * and page menus can run exports/imports without threading the instance
 * through props.
 */

export interface ActiveEditor {
  blocksToMarkdownLossy: () => Promise<string>;
  blocksToHTMLLossy: () => Promise<string>;
  tryParseMarkdownToBlocks: (md: string) => Promise<unknown[]>;
  insertBlocks: (blocks: unknown[], ref: unknown, placement: "after" | "before") => void;
  replaceBlocks: (toRemove: unknown[], toInsert: unknown[]) => void;
  document: { id: string }[];
}

let active: ActiveEditor | null = null;
let activePageId: string | null = null;

export function setActiveEditor(editor: ActiveEditor | null, pageId?: string) {
  active = editor;
  activePageId = editor ? (pageId ?? null) : null;
}

export function getActiveEditor(): ActiveEditor | null {
  return active;
}

/**
 * The mounted editor, but only if it's showing `pageId`. Used by page
 * history: a restore must repaint the open editor (BlockNote owns its own
 * document once mounted and doesn't re-read the replica), and must never
 * repaint an editor showing some *other* page.
 */
export function getActiveEditorFor(pageId: string): ActiveEditor | null {
  return activePageId === pageId ? active : null;
}

export function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeFilename(title: string): string {
  return (title.trim() || "Untitled").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
}
