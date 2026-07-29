import { DbProp, PageMeta } from "./types";
import { downloadFile, getActiveEditor, safeFilename } from "./editorRegistry";

export async function exportPageMarkdown(title: string): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const md = await editor.blocksToMarkdownLossy();
  downloadFile(
    `${safeFilename(title)}.md`,
    `# ${title || "Untitled"}\n\n${md}`,
    "text/markdown",
  );
  return true;
}

export async function copyPageMarkdown(title: string): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const md = await editor.blocksToMarkdownLossy();
  await navigator.clipboard.writeText(`# ${title || "Untitled"}\n\n${md}`);
  return true;
}

export async function exportPageHTML(title: string): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const html = await editor.blocksToHTMLLossy();
  downloadFile(
    `${safeFilename(title)}.html`,
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title || "Untitled"}</h1>${html}</body></html>`,
    "text/html",
  );
  return true;
}

export async function importMarkdownIntoPage(file: File): Promise<boolean> {
  const editor = getActiveEditor();
  if (!editor) return false;
  const text = await file.text();
  const blocks = await editor.tryParseMarkdownToBlocks(text);
  if (!blocks.length) return false;
  const doc = editor.document;
  const last = doc[doc.length - 1];
  editor.insertBlocks(blocks, last ? last.id : undefined, "after");
  return true;
}

export function exportDatabaseCSV(
  title: string,
  dbProps: DbProp[],
  rows: PageMeta[],
) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Name", ...dbProps.map((p) => p.name)].map(esc).join(",");
  const lines = rows.map((row) => {
    const cells = [row.title || "Untitled"];
    for (const prop of dbProps) {
      const raw = row.props?.[prop.id];
      if (raw === undefined || raw === null) {
        cells.push("");
      } else if (prop.type === "select" && typeof raw === "string") {
        cells.push(prop.options?.find((o) => o.id === raw)?.name ?? "");
      } else if (prop.type === "multiSelect" && Array.isArray(raw)) {
        cells.push(
          (raw as string[])
            .map((id) => prop.options?.find((o) => o.id === id)?.name ?? "")
            .filter(Boolean)
            .join("; "),
        );
      } else if (prop.type === "checkbox") {
        cells.push(raw === true ? "true" : "false");
      } else {
        cells.push(String(raw));
      }
    }
    return cells.map(esc).join(",");
  });
  downloadFile(
    `${safeFilename(title)}.csv`,
    [header, ...lines].join("\n"),
    "text/csv",
  );
}
