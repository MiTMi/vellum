import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  FileText,
  Database,
  Plus,
  CornerDownLeft,
  Moon,
  Sun,
  Trash2,
  Zap,
  LayoutTemplate,
} from "lucide-react";
import Modal from "./ui/Modal";
import { useMutations, useSearch } from "../data";
import { PagesIndex, PageId } from "../lib/types";
import { pathTo } from "../hooks/usePagesIndex";
import { useNav } from "../state";
import {
  isVaultPage,
  searchVaultTitles,
  useVaultVersion,
} from "../lib/vaultSession";

interface QuickSwitcherProps {
  index: PagesIndex;
  onClose: () => void;
  onOpenTrash: () => void;
}

interface Row {
  kind: "page" | "create" | "action";
  id?: PageId;
  title: string;
  icon: string | null;
  actionIcon?: React.ReactNode;
  type?: "doc" | "database";
  crumb?: string;
  snippet?: string | null;
  run?: () => void | Promise<void>;
  keywords?: string;
}

export default function QuickSwitcher({
  index,
  onClose,
  onOpenTrash,
}: QuickSwitcherProps) {
  const { navigate, theme, toggleTheme } = useNav();
  const mutations = useMutations();
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useSearch(term);
  const listRef = useRef<HTMLDivElement>(null);

  // Command-palette actions (⌘K in Notion runs commands, not just search).
  const actions = useMemo<Row[]>(
    () => [
      {
        kind: "action",
        title: "New page",
        icon: null,
        actionIcon: <Plus size={16} />,
        keywords: "new page create document",
        run: async () => navigate(await mutations.create({ type: "doc" })),
      },
      {
        kind: "action",
        title: "New database",
        icon: null,
        actionIcon: <Database size={16} />,
        keywords: "new database table board collection",
        run: async () => navigate(await mutations.create({ type: "database" })),
      },
      {
        kind: "action",
        title: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        icon: null,
        actionIcon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        keywords: "theme dark light mode appearance toggle",
        run: () => toggleTheme(),
      },
      {
        kind: "action",
        title: "Open trash",
        icon: null,
        actionIcon: <Trash2 size={16} />,
        keywords: "trash deleted bin restore",
        run: () => onOpenTrash(),
      },
      ...index.templates.map<Row>((t) => ({
        kind: "action" as const,
        title: `New from template: ${t.title || "Untitled"}`,
        icon: null,
        actionIcon: <LayoutTemplate size={16} />,
        keywords: `template new from ${t.title.toLowerCase()}`,
        run: async () => {
          const id = await mutations.duplicate({
            id: t._id,
            toRoot: true,
            suffix: "",
            asInstance: true,
          });
          if (id) navigate(id);
        },
      })),
    ],
    [mutations, navigate, theme, toggleTheme, onOpenTrash, index.templates],
  );

  const vaultVersion = useVaultVersion();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const q = term.trim().toLowerCase();
    if (q) {
      for (const hit of results ?? []) {
        // Vault pages never surface through stored search text (it's kept
        // empty for them); this filter is defense in depth.
        if (isVaultPage(hit._id)) continue;
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
          snippet: hit.snippet,
        });
      }
      // While the vault is unlocked, its pages are findable by (decrypted)
      // title — matched in memory, never from a stored index.
      for (const hit of searchVaultTitles(term)) {
        out.push({
          kind: "page",
          id: hit._id as PageId,
          title: hit.title || "Untitled",
          icon: "🔒",
          type: "doc",
          crumb: "Vault",
        });
      }
      for (const a of actions) {
        if (
          a.title.toLowerCase().includes(q) ||
          (a.keywords ?? "").includes(q)
        ) {
          out.push(a);
        }
      }
      out.push({
        kind: "create",
        title: `Create page “${term.trim()}”`,
        icon: null,
      });
    } else {
      out.push(...actions);
      const recent = [...index.all]
        .filter((p) => !p.vault) // never reveal vault pages here
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, results, index, actions, vaultVersion]);

  useEffect(() => setSelected(0), [term, rows.length]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = async (row: Row) => {
    if (row.kind === "create") {
      const id = await mutations.create({ type: "doc", title: term.trim() });
      navigate(id);
    } else if (row.kind === "action") {
      await row.run?.();
    } else if (row.id) {
      navigate(row.id);
    }
    onClose();
  };

  const firstRecentIdx = !term.trim() ? actions.length : -1;

  return (
    <Modal onClose={onClose} className="quick-switcher" top="14vh">
      <div className="qs-input-row">
        <Search size={17} />
        <input
          autoFocus
          placeholder="Search pages, run a command, or type to create…"
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
        {!term.trim() && rows.length > 0 && (
          <div className="qs-section">
            <Zap size={11} /> Actions
          </div>
        )}
        {rows.map((row, i) => (
          <React.Fragment key={rowKey(row, i)}>
            {i === firstRecentIdx && (
              <div className="qs-section">Recently edited</div>
            )}
            <button
              className={`qs-row ${i === selected ? "selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => void activate(row)}
            >
              <span className="qs-icon">
                {row.kind === "create" ? (
                  <Plus size={16} />
                ) : row.kind === "action" ? (
                  row.actionIcon
                ) : row.icon ? (
                  row.icon
                ) : row.type === "database" ? (
                  <Database size={16} />
                ) : (
                  <FileText size={16} />
                )}
              </span>
              <span className="qs-main">
                <span className="qs-title-row">
                  <span className="qs-title">{row.title}</span>
                  {row.crumb && <span className="qs-crumb">{row.crumb}</span>}
                </span>
                {row.snippet && (
                  <span className="qs-snippet">
                    {highlight(row.snippet, term.trim())}
                  </span>
                )}
              </span>
              {i === selected && (
                <CornerDownLeft size={14} className="qs-enter" />
              )}
            </button>
          </React.Fragment>
        ))}
        {rows.length === 0 && <div className="qs-empty">No results</div>}
      </div>
    </Modal>
  );
}

/**
 * Wrap every occurrence of `term` in <mark>. Split client-side rather than
 * sending HTML from the server — the snippet stays plain text everywhere.
 */
function highlight(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  let found = lower.indexOf(needle, at);
  while (found !== -1) {
    if (found > at) parts.push(text.slice(at, found));
    parts.push(
      <mark key={`${found}`}>{text.slice(found, found + term.length)}</mark>,
    );
    at = found + term.length;
    found = lower.indexOf(needle, at);
  }
  parts.push(text.slice(at));
  return parts;
}

function rowKey(row: Row, i: number): string {
  if (row.kind === "create") return "__create";
  if (row.kind === "action") return `__action_${row.title}`;
  return row.id ?? `row_${i}`;
}
