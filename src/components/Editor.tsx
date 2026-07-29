import { useEffect, useMemo, useRef, useState } from "react";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  BlockNoteEditor,
} from "@blocknote/core";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { FileText, Database } from "lucide-react";
import { PageDoc } from "../lib/types";
import { extractText } from "../lib/blocks";
import { useFileUpload, useMutations } from "../data";
import { useNav } from "../state";
import { PageLinkSpec } from "./PageLinkBlock";
import { setActiveEditor } from "../lib/editorRegistry";
import CodeCopyOverlay from "./CodeCopyOverlay";

const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    pageLink: PageLinkSpec(),
  },
});

interface EditorProps {
  page: PageDoc;
}

export default function PageEditor({ page }: EditorProps) {
  const { theme, navigate } = useNav();
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const mutations = useMutations();
  const upload = useFileUpload();

  const pageIdRef = useRef(page._id);
  pageIdRef.current = page._id;

  const initialContent = useMemo(
    () =>
      Array.isArray(page.content) && page.content.length > 0
        ? page.content
        : undefined,
    // Only recompute when switching pages — later server echoes of our own
    // saves must not reset the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page._id],
  );

  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: initialContent as never,
      uploadFile: upload,
      tables: {
        splitCells: true,
        cellBackgroundColor: true,
        cellTextColor: true,
        headers: true,
      },
    },
    [page._id],
  );

  // Debounced persistence, flushed on page switch / unmount.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ id: PageDoc["_id"]; editor: typeof editor } | null>(
    null,
  );

  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    // JSON round-trip: strips `undefined` values (e.g. auto table column
    // widths), which Convex rejects — undefined array entries become null.
    const blocks = JSON.parse(JSON.stringify(pending.editor.document));
    mutations
      .updateContent({
        id: pending.id,
        content: blocks,
        text: extractText(blocks),
      })
      .catch((err) => console.error("Failed to save page content:", err));
  };

  const scheduleSave = () => {
    pendingRef.current = { id: pageIdRef.current, editor };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 350);
  };

  useEffect(() => {
    // Flush pending edits when switching pages, closing the window, or
    // unmounting — nothing typed should ever be lost to the debounce.
    // The sync engine also fires vellum:flush-edits right before remapping
    // an offline-created page's id, so debounced edits land under the old
    // id and get remapped with everything else.
    window.addEventListener("beforeunload", flush);
    window.addEventListener("vellum:flush-edits", flush);
    setActiveEditor(editor as never);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("vellum:flush-edits", flush);
      setActiveEditor(null);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page._id, editor]);

  const getSlashItems = async (
    query: string,
  ): Promise<DefaultReactSuggestionItem[]> => {
    const defaults = getDefaultReactSlashMenuItems(editor);
    const custom: DefaultReactSuggestionItem[] = [
      {
        title: "Sub-page",
        subtext: "Create a page inside this page",
        aliases: ["subpage", "page", "child"],
        group: "Vellum",
        icon: <FileText size={18} />,
        onItemClick: () => {
          void (async () => {
            const id = await mutations.create({
              parentId: page._id,
              type: "doc",
            });
            insertOrUpdateBlockForSlashMenu(
              editor as unknown as BlockNoteEditor,
              { type: "pageLink", props: { pageId: id } } as never,
            );
            navigate(id);
          })();
        },
      },
      {
        title: "Database",
        subtext: "Create an inline table/board database",
        aliases: ["db", "table", "board", "kanban", "collection"],
        group: "Vellum",
        icon: <Database size={18} />,
        onItemClick: () => {
          void (async () => {
            const id = await mutations.create({
              parentId: page._id,
              type: "database",
            });
            insertOrUpdateBlockForSlashMenu(
              editor as unknown as BlockNoteEditor,
              { type: "pageLink", props: { pageId: id } } as never,
            );
            navigate(id);
          })();
        },
      },
    ];
    return filterSuggestionItems([...defaults, ...custom], query);
  };

  return (
    <div className="editor-wrap" ref={setWrapEl}>
      <BlockNoteView
        editor={editor}
        theme={theme}
        editable={!page.locked}
        onChange={scheduleSave}
        slashMenu={false}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />
      </BlockNoteView>
      <CodeCopyOverlay container={wrapEl} />
    </div>
  );
}
