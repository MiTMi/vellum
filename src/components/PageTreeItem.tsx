import React, { useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  Database,
  Plus,
  MoreHorizontal,
  Star,
  StarOff,
  Copy,
  Trash2,
  PenLine,
} from "lucide-react";
import { PageMeta, PageId, PagesIndex, childrenKey } from "../lib/types";
import { useMutations } from "../data";
import { useNav } from "../state";
import { rankBetween } from "../lib/ranks";
import Menu from "./ui/Menu";

export interface DragState {
  dragId: PageId | null;
  setDragId: (id: PageId | null) => void;
}

interface ItemProps {
  page: PageMeta;
  depth: number;
  index: PagesIndex;
  expanded: Set<string>;
  toggleExpanded: (id: string) => void;
  drag: DragState;
  siblings: PageMeta[];
  position: number;
}

type DropZone = "before" | "after" | "inside" | null;

export default function PageTreeItem({
  page,
  depth,
  index,
  expanded,
  toggleExpanded,
  drag,
  siblings,
  position,
}: ItemProps) {
  const { pageId, navigate } = useNav();
  const mutations = useMutations();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [dropZone, setDropZone] = useState<DropZone>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const kids = index.children.get(childrenKey(page._id)) ?? [];
  const hasKids = kids.length > 0;
  const isOpen = expanded.has(page._id);
  const isActive = pageId === page._id;

  const onDragOver = (e: React.DragEvent) => {
    if (!drag.dragId || drag.dragId === page._id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = rowRef.current!.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < rect.height * 0.28) setDropZone("before");
    else if (y > rect.height * 0.72) setDropZone("after");
    else setDropZone("inside");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dragId = drag.dragId;
    const zone = dropZone;
    setDropZone(null);
    drag.setDragId(null);
    if (!dragId || dragId === page._id || !zone) return;
    if (zone === "inside") {
      const newKids = index.children.get(childrenKey(page._id)) ?? [];
      const last = newKids[newKids.length - 1] ?? null;
      void mutations.move({
        id: dragId,
        parentId: page._id,
        rank: rankBetween(last, null),
      });
      if (!isOpen) toggleExpanded(page._id);
    } else {
      const list = siblings.filter((s) => s._id !== dragId);
      const pos = list.findIndex((s) => s._id === page._id);
      const before = zone === "before" ? (list[pos - 1] ?? null) : list[pos];
      const after = zone === "before" ? list[pos] : (list[pos + 1] ?? null);
      void mutations.move({
        id: dragId,
        parentId: page.parentId ?? undefined,
        rank: rankBetween(before, after),
      });
    }
  };

  const commitRename = () => {
    setRenaming(false);
    const title = renameValue.trim();
    if (title !== page.title) {
      void mutations.rename({ id: page._id, title });
    }
  };

  return (
    <div className="tree-node">
      <div
        ref={rowRef}
        className={`tree-row ${isActive ? "active" : ""} ${dropZone ? `drop-${dropZone}` : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          drag.setDragId(page._id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", page.title || "Untitled");
        }}
        onDragEnd={() => {
          drag.setDragId(null);
          setDropZone(null);
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropZone(null)}
        onDrop={onDrop}
        onClick={() => navigate(page._id)}
      >
        <button
          className={`tree-chevron ${isOpen ? "open" : ""} ${hasKids ? "" : "hidden-chevron"}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(page._id);
          }}
          tabIndex={-1}
        >
          <ChevronRight size={14} />
        </button>
        <span className="tree-icon">
          {page.icon ? (
            page.icon
          ) : page.type === "database" ? (
            <Database size={15} />
          ) : (
            <FileText size={15} />
          )}
        </span>
        {renaming ? (
          <input
            className="tree-rename"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree-title">{page.title || "Untitled"}</span>
        )}
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="tree-action"
            title="More"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            className="tree-action"
            title="Add a page inside"
            onClick={async () => {
              const id = await mutations.create({
                parentId: page._id,
                type: "doc",
              });
              if (!isOpen) toggleExpanded(page._id);
              navigate(id);
            }}
          >
            <Plus size={14} />
          </button>
        </span>
      </div>

      {menuAnchor && (
        <Menu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          items={[
            {
              label: page.isFavorite ? "Remove from favorites" : "Add to favorites",
              icon: page.isFavorite ? <StarOff size={15} /> : <Star size={15} />,
              onClick: () => void mutations.toggleFavorite({ id: page._id }),
            },
            {
              label: "Rename",
              icon: <PenLine size={15} />,
              onClick: () => {
                setRenameValue(page.title);
                setRenaming(true);
              },
            },
            {
              label: "Duplicate",
              icon: <Copy size={15} />,
              onClick: () => void mutations.duplicate({ id: page._id }),
            },
            "divider",
            {
              label: "Move to trash",
              icon: <Trash2 size={15} />,
              danger: true,
              onClick: () => {
                void mutations.trash({ id: page._id });
                if (isActive) navigate(null);
              },
            },
          ]}
        />
      )}

      {isOpen && hasKids && (
        <div className="tree-children">
          {kids.map((kid, i) => (
            <PageTreeItem
              key={kid._id}
              page={kid}
              depth={depth + 1}
              index={index}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              drag={drag}
              siblings={kids}
              position={i}
            />
          ))}
        </div>
      )}
      {isOpen && !hasKids && (
        <div
          className="tree-empty"
          style={{ paddingLeft: 30 + depth * 14 }}
        >
          No pages inside
        </div>
      )}
    </div>
  );
}
