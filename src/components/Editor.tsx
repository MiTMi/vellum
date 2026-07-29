import { useEffect, useMemo, useRef, useState } from "react";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
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
import { autoPlacement, offset, shift, size } from "@floating-ui/react";
import {
  FileText,
  Database,
  Link2,
  Info,
  List,
  Bookmark,
  Sigma,
} from "lucide-react";
import { PageDoc } from "../lib/types";
import { extractText } from "../lib/blocks";
import { useFileUpload, useLinkPreview, useMutations } from "../data";
import { useNav } from "../state";
import { registrySnapshot } from "../lib/pageRegistry";
import { setLinkPreviewFetcher } from "../lib/linkPreviewRegistry";
import { PageLinkSpec } from "./PageLinkBlock";
import { CalloutSpec } from "./CalloutBlock";
import { TocSpec } from "./TocBlock";
import { BookmarkSpec } from "./BookmarkBlock";
import { EquationSpec } from "./EquationBlock";
import { PageMentionSpec } from "./PageMentionInline";
import BlockAnchorOverlay from "./BlockAnchorOverlay";
import { clearActiveEditor, setActiveEditor } from "../lib/editorRegistry";
import CodeCopyOverlay from "./CodeCopyOverlay";

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    pageLink: PageLinkSpec(),
    callout: CalloutSpec(),
    toc: TocSpec(),
    bookmark: BookmarkSpec(),
    equation: EquationSpec(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    // Unlike createReactBlockSpec, createReactInlineContentSpec returns the
    // spec itself rather than a factory — no call here.
    pageMention: PageMentionSpec,
  },
});

/*
 * BlockNote's default popover middleware has a feedback loop: when the menu
 * opens on a side with very little room, size() clamps it to that sliver;
 * on the next update the now-tiny menu "fits" on both sides, so
 * autoPlacement keeps the cramped side and the menu ends up a few rows tall
 * (or clipped at the window edge). Enforcing a minimum height keeps the
 * cramped side overflowing, which makes placement flip to the roomier one.
 */
const MENU_MIN_HEIGHT = 220;
const MENU_MAX_HEIGHT = 420;
const suggestionMenuFloatingOptions = {
  useFloatingOptions: {
    middleware: [
      offset(10),
      autoPlacement({
        allowedPlacements: ["bottom-start", "top-start"] as const,
        padding: 10,
      }),
      shift({ padding: 10 }),
      size({
        padding: 10,
        apply({
          elements,
          availableHeight,
        }: {
          elements: { floating: HTMLElement };
          availableHeight: number;
        }) {
          const height = Math.max(MENU_MIN_HEIGHT, availableHeight);
          elements.floating.style.maxHeight = `${Math.min(height, MENU_MAX_HEIGHT)}px`;
        },
      }),
    ],
  },
};

interface EditorProps {
  page: PageDoc;
}

export default function PageEditor({ page }: EditorProps) {
  const { theme, navigate } = useNav();
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const mutations = useMutations();
  const upload = useFileUpload();
  const linkPreview = useLinkPreview();

  const pageIdRef = useRef(page._id);
  pageIdRef.current = page._id;

  // Custom blocks can't reach React context — hand the fetcher to the
  // module registry the bookmark block reads from.
  useEffect(() => {
    setLinkPreviewFetcher(linkPreview);
    return () => setLinkPreviewFetcher(null);
  }, [linkPreview]);

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
    setActiveEditor(editor as never, page._id);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("vellum:flush-edits", flush);
      clearActiveEditor(editor as never);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page._id, editor]);

  const insertPageLink = (pageId: string) => {
    insertOrUpdateBlockForSlashMenu(
      editor as unknown as BlockNoteEditor,
      { type: "pageLink", props: { pageId } } as never,
    );
  };

  // Inline chip inside the current paragraph (Notion's @-mention), as
  // opposed to insertPageLink's standalone block.
  const insertPageMention = (pageId: string) => {
    editor.insertInlineContent([
      { type: "pageMention", props: { pageId } },
      " ",
    ] as never);
  };

  // "@" menu — link an existing page inline, Notion-style. Every link also
  // shows up as a backlink ("Linked mentions") on the target page.
  const getMentionItems = async (
    query: string,
  ): Promise<DefaultReactSuggestionItem[]> => {
    const q = query.trim().toLowerCase();
    const items: DefaultReactSuggestionItem[] = [];
    for (const [id, p] of registrySnapshot()) {
      if (id === page._id || p.inTrash) continue;
      const title = p.title || "Untitled";
      if (q && !title.toLowerCase().includes(q)) continue;
      items.push({
        title,
        subtext: p.type === "database" ? "Database" : "Page",
        group: "Link to page",
        icon: p.icon ? (
          <span>{p.icon}</span>
        ) : p.type === "database" ? (
          <Database size={18} />
        ) : (
          <FileText size={18} />
        ),
        onItemClick: () => insertPageMention(id),
      });
      if (items.length >= 12) break;
    }
    return items;
  };

  const openMentionMenu = () => {
    const suggestions = editor.getExtension("suggestionMenu") as
      | { openSuggestionMenu?: (trigger: string) => void }
      | undefined;
    suggestions?.openSuggestionMenu?.("@");
  };

  const getSlashItems = async (
    query: string,
  ): Promise<DefaultReactSuggestionItem[]> => {
    const defaults = getDefaultReactSlashMenuItems(editor);
    const custom: DefaultReactSuggestionItem[] = [
      {
        title: "Link to page",
        subtext: "Link an existing page (or type @)",
        aliases: ["link", "mention", "backlink", "@"],
        group: "Vellum",
        icon: <Link2 size={18} />,
        onItemClick: openMentionMenu,
      },
      {
        title: "Callout",
        subtext: "Make text stand out in a colored box",
        aliases: ["callout", "note", "info", "tip", "highlight"],
        group: "Vellum",
        icon: <Info size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(
            editor as unknown as BlockNoteEditor,
            { type: "callout" } as never,
          );
        },
      },
      {
        title: "Web bookmark",
        subtext: "Save a link as a visual card",
        aliases: ["bookmark", "link", "url", "embed", "preview", "web"],
        group: "Vellum",
        icon: <Bookmark size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(
            editor as unknown as BlockNoteEditor,
            { type: "bookmark" } as never,
          );
        },
      },
      {
        title: "Equation",
        subtext: "Display a LaTeX formula",
        aliases: ["equation", "math", "latex", "katex", "formula"],
        group: "Vellum",
        icon: <Sigma size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(
            editor as unknown as BlockNoteEditor,
            { type: "equation" } as never,
          );
        },
      },
      {
        title: "Table of contents",
        subtext: "Auto-updating outline of this page's headings",
        aliases: ["toc", "table of contents", "outline", "contents"],
        group: "Vellum",
        icon: <List size={18} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(
            editor as unknown as BlockNoteEditor,
            { type: "toc" } as never,
          );
        },
      },
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
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={getSlashItems}
          floatingUIOptions={suggestionMenuFloatingOptions}
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={getMentionItems}
          floatingUIOptions={suggestionMenuFloatingOptions}
        />
      </BlockNoteView>
      <CodeCopyOverlay container={wrapEl} />
      <BlockAnchorOverlay container={wrapEl} pageId={page._id} />
    </div>
  );
}
