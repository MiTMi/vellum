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
  Globe,
  Check,
  ExternalLink,
  Library as LibraryIcon,
} from "lucide-react";
import { PagesIndex, PageMeta, childrenKey } from "../lib/types";
import { isLibraryId, LIBRARY_ID } from "../lib/library";
import { pathTo } from "../hooks/usePagesIndex";
import { useMutations, usePage, usePublish } from "../data";
import { useNav } from "../state";
import { displayTitle, useVaultVersion } from "../lib/vaultSession";
import Popover from "./ui/Popover";
import PageMenu from "./PageMenu";
import {
  exportDatabaseCSV,
  exportPageHTML,
  exportPageMarkdown,
  exportPagePDF,
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
  useVaultVersion(); // breadcrumb titles change on vault lock/unlock
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
          {isLibraryId(pageId) && (
            <button className="crumb" onClick={() => navigate(LIBRARY_ID)}>
              <span className="crumb-icon">
                <LibraryIcon size={14} />
              </span>
              <span>Library</span>
            </button>
          )}
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
                  <span>{displayTitle(c) || "Untitled"}</span>
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
    <Popover anchor={anchor} onClose={onClose} align="right" className="menu" width={280}>
      <PublishSection page={page} />
      <div className="menu-divider" />
      <div className="prop-menu-label">Export</div>
      {isDatabase ? (
        <button
          className="menu-item"
          onClick={() =>
            void run(() =>
              exportDatabaseCSV(
                displayTitle(page),
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
            onClick={() => void run(() => exportPageMarkdown(displayTitle(page)))}
          >
            <span className="menu-icon">
              <FileDown size={15} />
            </span>
            <span>Export as Markdown</span>
          </button>
          <button
            className="menu-item"
            disabled={busy}
            onClick={() => void run(() => exportPageHTML(displayTitle(page)))}
          >
            <span className="menu-icon">
              <FileCode size={15} />
            </span>
            <span>Export as HTML</span>
          </button>
          <button
            className="menu-item"
            disabled={busy}
            onClick={() => void run(() => exportPagePDF(displayTitle(page)))}
          >
            <span className="menu-icon">
              <FileDown size={15} />
            </span>
            <span>Export as PDF</span>
          </button>
        </>
      )}
      <div className="share-note">Files download to your Downloads folder.</div>
    </Popover>
  );
}

/**
 * Publish to web. The slug returned by the server is the only thing that
 * makes the page reachable, so "unpublish" genuinely revokes the old link
 * rather than hiding it — worth saying plainly in the UI.
 */
function PublishSection({ page }: { page: PageMeta }) {
  const publish = usePublish();
  const fullPage = usePage(page._id);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = fullPage?.publicSlug ?? null;
  const url = slug ? publish.urlFor(slug) : null;

  const toggle = async (value: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await publish.set(page._id, value);
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };

  // The server rejects publishing vault pages; don't offer the toggle.
  if (page.vault) {
    return (
      <>
        <div className="prop-menu-label">Share to web</div>
        <div className="share-note">
          Vault pages are end-to-end encrypted and can't be published.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="prop-menu-label">Share to web</div>
      {!publish.available ? (
        <div className="share-note">
          Publishing needs a connection — reconnect to share this page.
        </div>
      ) : (
        <>
          <button
            className="menu-item toggle-row"
            disabled={busy}
            onClick={() => void toggle(!slug)}
          >
            <span className="menu-icon">
              <Globe size={15} />
            </span>
            <span>{slug ? "Published" : "Publish to web"}</span>
            <span className={`switch ${slug ? "on" : ""}`} role="switch" aria-checked={!!slug}>
              <span className="switch-knob" />
            </span>
          </button>

          {slug && url && (
            <div className="publish-box">
              <input className="publish-link" readOnly value={url} onFocus={(e) => e.target.select()} />
              <div className="publish-actions">
                <button
                  className="btn subtle"
                  onClick={async () => {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
                <a className="btn subtle" href={url} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} /> Open
                </a>
              </div>
              <div className="share-note">
                Anyone with this link can read the page. Unpublishing breaks it
                permanently.
              </div>
            </div>
          )}
          {error && <div className="share-note error">{error}</div>}
        </>
      )}
    </>
  );
}
