import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Plus,
  Trash2,
  Star,
  FileText,
  Database,
  ChevronsLeft,
  History,
} from "lucide-react";
import { PageId, PagesIndex } from "../lib/types";
import { useMutations } from "../data";
import { useNav } from "../state";
import PageTreeItem from "./PageTreeItem";
import Menu from "./ui/Menu";

interface SidebarProps {
  index: PagesIndex;
  onOpenSearch: () => void;
  onOpenTrash: () => void;
  onCollapse: () => void;
  width: number;
  setWidth: (w: number) => void;
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem("vellum:expanded");
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

export default function Sidebar({
  index,
  onOpenSearch,
  onOpenTrash,
  onCollapse,
  width,
  setWidth,
}: SidebarProps) {
  const { navigate } = useNav();
  const mutations = useMutations();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [dragId, setDragId] = useState<PageId | null>(null);
  const [newMenuAnchor, setNewMenuAnchor] = useState<HTMLElement | null>(null);
  const resizing = useRef(false);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("vellum:expanded", JSON.stringify([...next]));
      return next;
    });
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      setWidth(Math.min(440, Math.max(200, e.clientX)));
    };
    const onUp = () => {
      resizing.current = false;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setWidth]);

  const roots = index.children.get("root") ?? [];
  const drag = { dragId, setDragId };

  const newPage = async (type: "doc" | "database") => {
    const id = await mutations.create({ type });
    navigate(id);
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-top drag-region">
        <div className="workspace-badge no-drag">
          <span className="workspace-logo">V</span>
          <span className="workspace-name">Vellum</span>
        </div>
        <button
          className="icon-btn no-drag"
          title="Collapse sidebar (⌘\)"
          onClick={onCollapse}
        >
          <ChevronsLeft size={17} />
        </button>
      </div>

      <div className="sidebar-static">
        <button className="sidebar-item" onClick={onOpenSearch}>
          <Search size={15} />
          <span>Search</span>
          <kbd className="kbd">⌘K</kbd>
        </button>
      </div>

      <div className="sidebar-scroll">
        {index.all.length > 1 && (
          <>
            <div className="sidebar-heading">
              <History size={11} /> Recents
            </div>
            {[...index.all]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 5)
              .map((p) => (
                <button
                  key={p._id}
                  className="sidebar-item fav-item"
                  onClick={() => navigate(p._id)}
                >
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
                </button>
              ))}
          </>
        )}
        {index.favorites.length > 0 && (
          <>
            <div className="sidebar-heading">
              <Star size={11} /> Favorites
            </div>
            {index.favorites.map((p) => (
              <button
                key={p._id}
                className="sidebar-item fav-item"
                onClick={() => navigate(p._id)}
              >
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
              </button>
            ))}
          </>
        )}

        <div className="sidebar-heading">Private</div>
        <div
          className="tree-root"
          onDragOver={(e) => {
            if (dragId) e.preventDefault();
          }}
          onDrop={(e) => {
            // Drop on empty area → move to root, end of list.
            if (!dragId) return;
            e.preventDefault();
            const last = roots[roots.length - 1] ?? null;
            void mutations.move({
              id: dragId,
              parentId: undefined,
              rank: last ? last.rank + 1024 : 1024,
            });
            setDragId(null);
          }}
        >
          {roots.map((p, i) => (
            <PageTreeItem
              key={p._id}
              page={p}
              depth={0}
              index={index}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              drag={drag}
              siblings={roots}
              position={i}
            />
          ))}
          {roots.length === 0 && !index.loading && (
            <div className="tree-empty" style={{ paddingLeft: 12 }}>
              No pages yet
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <button
          className="sidebar-item new-page"
          onClick={() => void newPage("doc")}
          onContextMenu={(e) => {
            e.preventDefault();
            setNewMenuAnchor(e.currentTarget);
          }}
        >
          <Plus size={15} />
          <span>New page</span>
        </button>
        <button
          className="icon-btn"
          title="New database"
          onClick={(e) => setNewMenuAnchor(e.currentTarget)}
        >
          <Database size={15} />
        </button>
        <button className="icon-btn" title="Trash" onClick={onOpenTrash}>
          <Trash2 size={15} />
        </button>
      </div>

      {newMenuAnchor && (
        <Menu
          anchor={newMenuAnchor}
          onClose={() => setNewMenuAnchor(null)}
          items={[
            {
              label: "New page",
              icon: <FileText size={15} />,
              onClick: () => void newPage("doc"),
            },
            {
              label: "New database",
              icon: <Database size={15} />,
              onClick: () => void newPage("database"),
            },
          ]}
        />
      )}

      <div
        className="sidebar-resizer"
        onMouseDown={() => {
          resizing.current = true;
          document.body.classList.add("resizing");
        }}
      />
    </aside>
  );
}
