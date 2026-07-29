import React, { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Star,
  MoreHorizontal,
  Sun,
  Moon,
  Copy,
  Trash2,
  FileText,
  Database,
  FileDown,
  FileCode,
  Table,
  Share as ShareIcon,
} from "lucide-react";
import { PagesIndex, PageMeta, childrenKey } from "../lib/types";
import { pathTo } from "../hooks/usePagesIndex";
import { useMutations, usePage } from "../data";
import { useNav } from "../state";
import Popover from "./ui/Popover";
import PageMenu from "./PageMenu";
import {
  exportDatabaseCSV,
  exportPageHTML,
  exportPageMarkdown,
} from "../lib/exporters";

interface TopBarProps {
  index: PagesIndex;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function TopBar({ index }: TopBarProps) {
  const { pageId, navigate, back, forward, canBack, canForward, theme, toggleTheme } =
    useNav();
  const mutations = useMutations();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);

  const path = pathTo(index, pageId);
  const page = pageId ? index.byId.get(pageId) : undefined;
  const crumbs = path.length > 3 ? [path[0], null, path[path.length - 1]] : path;

  return (
    <header className="topbar drag-region">
      <div className="topbar-left no-drag">
        <button className="icon-btn" disabled={!canBack} onClick={back} title="Back">
          <ChevronLeft size={17} />
        </button>
        <button
          className="icon-btn"
          disabled={!canForward}
          onClick={forward}
          title="Forward"
        >
          <ChevronRight size={17} />
        </button>
        <nav className="breadcrumbs">
          {crumbs.map((c, i) =>
            c === null ? (
              <span key="ellipsis" className="crumb-sep">
                …
              </span>
            ) : (
              <React.Fragment key={c._id}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button className="crumb" onClick={() => navigate(c._id)}>
                  {c.icon && <span className="crumb-icon">{c.icon}</span>}
                  <span>{c.title || "Untitled"}</span>
                </button>
              </React.Fragment>
            ),
          )}
        </nav>
      </div>
      <div className="topbar-right no-drag">
        {page && (
          <span className="edited-at" title={new Date(page.updatedAt).toLocaleString()}>
            Edited {timeAgo(page.updatedAt)}
          </span>
        )}
        {page && (
          <button
            className="btn subtle share-btn"
            onClick={(e) => setShareAnchor(e.currentTarget)}
          >
            <ShareIcon size={14} /> Share
          </button>
        )}
        {page && (
          <button
            className={`icon-btn ${page.isFavorite ? "starred" : ""}`}
            title={page.isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={() => void mutations.toggleFavorite({ id: page._id })}
          >
            <Star size={16} fill={page.isFavorite ? "currentColor" : "none"} />
          </button>
        )}
        <button
          className="icon-btn"
          title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          onClick={toggleTheme}
        >
          {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        {page && (
          <button
            className="icon-btn"
            title="More"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      </div>

      {shareAnchor && page && (
        <SharePopover
          anchor={shareAnchor}
          onClose={() => setShareAnchor(null)}
          page={page}
          index={index}
        />
      )}

      {menuAnchor && page && (
        <PageMenu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          page={page}
          index={index}
        />
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ */

function SharePopover({
  anchor,
  onClose,
  page,
  index,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  page: PageMeta;
  index: PagesIndex;
}) {
  const fullPage = usePage(page._id);
  const [busy, setBusy] = useState(false);
  const isDatabase = page.type === "database";

  const run = async (fn: () => Promise<unknown> | unknown) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} align="right" className="menu" width={240}>
      <div className="prop-menu-label">Export</div>
      {isDatabase ? (
        <button
          className="menu-item"
          onClick={() =>
            void run(() =>
              exportDatabaseCSV(
                page.title,
                fullPage?.dbProps ?? [],
                index.children.get(childrenKey(page._id)) ?? [],
              ),
            )
          }
        >
          <span className="menu-icon">
            <Table size={15} />
          </span>
          <span>Export as CSV</span>
        </button>
      ) : (
        <>
          <button
            className="menu-item"
            disabled={busy}
            onClick={() => void run(() => exportPageMarkdown(page.title))}
          >
            <span className="menu-icon">
              <FileDown size={15} />
            </span>
            <span>Export as Markdown</span>
          </button>
          <button
            className="menu-item"
            disabled={busy}
            onClick={() => void run(() => exportPageHTML(page.title))}
          >
            <span className="menu-icon">
              <FileCode size={15} />
            </span>
            <span>Export as HTML</span>
          </button>
        </>
      )}
      <div className="share-note">Files download to your Downloads folder.</div>
    </Popover>
  );
}
