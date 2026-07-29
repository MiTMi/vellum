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
  document: { id: string }[];
}

let active: ActiveEditor | null = null;

export function setActiveEditor(editor: ActiveEditor | null) {
  active = editor;
}

export function getActiveEditor(): ActiveEditor | null {
  return active;
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
