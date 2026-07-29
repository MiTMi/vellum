import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, FileText, Database, Plus, CornerDownLeft } from "lucide-react";
import Modal from "./ui/Modal";
import { useMutations, useSearch } from "../data";
import { PagesIndex, PageId } from "../lib/types";
import { pathTo } from "../hooks/usePagesIndex";
import { useNav } from "../state";

interface QuickSwitcherProps {
  index: PagesIndex;
  onClose: () => void;
}

interface Row {
  kind: "page" | "create";
  id?: PageId;
  title: string;
  icon: string | null;
  type?: "doc" | "database";
  crumb?: string;
}

export default function QuickSwitcher({ index, onClose }: QuickSwitcherProps) {
  const { navigate } = useNav();
  const mutations = useMutations();
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useSearch(term);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (term.trim()) {
      for (const hit of results ?? []) {
        const crumbPath = pathTo(index, hit.parentId)
          .map((p) => p.title || "Untitled")
          .join(" / ");
        out.push({
          kind: "page",
          id: hit._id,
          title: hit.title || "Untitled",
          icon: hit.icon,
          type: hit.type,
          crumb: crumbPath,
        });
      }
      out.push({
        kind: "create",
        title: `Create page “${term.trim()}”`,
        icon: null,
      });
    } else {
      const recent = [...index.all]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8);
      for (const p of recent) {
        const crumbPath = pathTo(index, p.parentId)
          .map((x) => x.title || "Untitled")
          .join(" / ");
        out.push({
          kind: "page",
          id: p._id,
          title: p.title || "Untitled",
          icon: p.icon,
          type: p.type,
          crumb: crumbPath,
        });
      }
    }
    return out;
  }, [term, results, index]);

  useEffect(() => setSelected(0), [term, rows.length]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = async (row: Row) => {
    if (row.kind === "create") {
      const id = await mutations.create({ type: "doc", title: term.trim() });
      navigate(id);
    } else if (row.id) {
      navigate(row.id);
    }
    onClose();
  };

  return (
    <Modal onClose={onClose} className="quick-switcher" top="14vh">
      <div className="qs-input-row">
        <Search size={17} />
        <input
          autoFocus
          placeholder="Search pages, or type to create…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && rows[selected]) {
              void activate(rows[selected]);
            }
          }}
        />
        <kbd className="kbd">esc</kbd>
      </div>
      <div className="qs-results" ref={listRef}>
        {rows.map((row, i) => (
          <button
            key={row.kind === "create" ? "__create" : row.id}
            className={`qs-row ${i === selected ? "selected" : ""}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => void activate(row)}
          >
            <span className="qs-icon">
              {row.kind === "create" ? (
                <Plus size={16} />
              ) : row.icon ? (
                row.icon
              ) : row.type === "database" ? (
                <Database size={16} />
              ) : (
                <FileText size={16} />
              )}
            </span>
            <span className="qs-title">{row.title}</span>
            {row.crumb && <span className="qs-crumb">{row.crumb}</span>}
            {i === selected && <CornerDownLeft size={14} className="qs-enter" />}
          </button>
        ))}
        {rows.length === 0 && <div className="qs-empty">No results</div>}
      </div>
      {!term.trim() && <div className="qs-footer">Recently edited</div>}
    </Modal>
  );
}
