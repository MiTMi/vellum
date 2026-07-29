import React, { useEffect, useRef, useState } from "react";
import {
  Smile,
  ImageIcon,
  Link2,
  ChevronDown,
  ChevronRight,
  FileText,
  Database,
} from "lucide-react";
import { PageDoc, PageId, PagesIndex } from "../lib/types";
import { usePage, useMutations, useBacklinks } from "../data";
import { useNav } from "../state";
import { coverBackground } from "../lib/colors";
import Editor from "./Editor";
import DatabaseView from "./database/DatabaseView";
import RowPropsPanel from "./database/RowProps";
import IconPicker from "./IconPicker";
import CoverPicker from "./CoverPicker";

interface PageViewProps {
  pageId: PageId;
  index: PagesIndex;
}

export default function PageView({ pageId, index }: PageViewProps) {
  const page = usePage(pageId);
  const parentMeta = page?.parentId ? index.byId.get(page.parentId) : undefined;
  const isRow = parentMeta?.type === "database";
  const database = usePage(isRow ? (page!.parentId as PageId) : null);

  if (page === undefined) {
    return <div className="page-loading" />;
  }
  if (page === null) {
    return (
      <div className="page-missing">
        <h2>Page not found</h2>
        <p>It may have been deleted.</p>
      </div>
    );
  }

  return (
    <PageBody
      key={page._id}
      page={page}
      index={index}
      database={isRow ? (database ?? null) : null}
    />
  );
}

function PageBody({
  page,
  index,
  database,
}: {
  page: PageDoc;
  index: PagesIndex;
  database: PageDoc | null;
}) {
  const mutations = useMutations();
  const [title, setTitle] = useState(page.title);
  const [iconAnchor, setIconAnchor] = useState<HTMLElement | null>(null);
  const [coverAnchor, setCoverAnchor] = useState<HTMLElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local title when the server copy changes elsewhere (rename in
  // sidebar, another window) — but not while the user is typing here.
  const editingTitle = useRef(false);
  useEffect(() => {
    if (!editingTitle.current) setTitle(page.title);
  }, [page.title]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title]);

  // Debounced rename, flushed on unmount / flush-edits — a pending title
  // must survive page switches and the sync engine's id remaps.
  const pendingTitle = useRef<string | null>(null);
  const flushTitle = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingTitle.current === null) return;
    const value = pendingTitle.current;
    pendingTitle.current = null;
    void mutations.rename({ id: page._id, title: value.trim() });
  };

  const commitTitle = (value: string) => {
    setTitle(value);
    pendingTitle.current = value;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushTitle, 300);
  };

  useEffect(() => {
    window.addEventListener("beforeunload", flushTitle);
    window.addEventListener("vellum:flush-edits", flushTitle);
    return () => {
      window.removeEventListener("beforeunload", flushTitle);
      window.removeEventListener("vellum:flush-edits", flushTitle);
      flushTitle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page._id]);

  const isDatabase = page.type === "database";
  const locked = page.locked ?? false;

  return (
    <div
      className={`page-view font-${page.font ?? "default"} ${page.smallText ? "small-text" : ""} ${locked ? "locked" : ""}`}
    >
      {page.cover && (
        <div className="page-cover" style={{ background: coverBackground(page.cover) }}>
          {!locked && (
            <div className="cover-actions">
              <button className="cover-btn" onClick={(e) => setCoverAnchor(e.currentTarget)}>
                Change cover
              </button>
            </div>
          )}
        </div>
      )}

      <div className={`page-inner ${isDatabase ? "wide" : ""} ${page.fullWidth ? "full" : ""}`}>
        <div className={`page-head ${page.cover ? "has-cover" : ""}`}>
          {page.icon && (
            <button
              className={`page-icon ${page.cover ? "overlap" : ""}`}
              onClick={(e) => !locked && setIconAnchor(e.currentTarget)}
              title={locked ? undefined : "Change icon"}
            >
              {page.icon}
            </button>
          )}

          {!locked && (
            <div className="page-head-actions">
              {!page.icon && (
                <button
                  className="head-action"
                  onClick={(e) => setIconAnchor(e.currentTarget)}
                >
                  <Smile size={14} /> Add icon
                </button>
              )}
              {!page.cover && (
                <button
                  className="head-action"
                  onClick={(e) => setCoverAnchor(e.currentTarget)}
                >
                  <ImageIcon size={14} /> Add cover
                </button>
              )}
            </div>
          )}
          {locked && <div className="locked-note">🔒 Page locked</div>}

          <textarea
            ref={titleRef}
            className="page-title"
            value={title}
            readOnly={locked}
            placeholder={isDatabase ? "Untitled database" : "Untitled"}
            rows={1}
            onFocus={() => (editingTitle.current = true)}
            onBlur={() => (editingTitle.current = false)}
            onChange={(e) => !locked && commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (document.querySelector(".bn-editor") as HTMLElement | null)?.focus();
              }
            }}
          />
        </div>

        {database && <RowPropsPanel row={page} database={database} />}

        {isDatabase ? (
          <DatabaseView page={page} index={index} locked={locked} />
        ) : (
          <Editor page={page} />
        )}

        <LinkedMentions pageId={page._id} />
      </div>

      {iconAnchor && (
        <IconPicker
          anchor={iconAnchor}
          onClose={() => setIconAnchor(null)}
          onPick={(emoji) => void mutations.setIcon({ id: page._id, icon: emoji })}
          onRemove={
            page.icon
              ? () => void mutations.setIcon({ id: page._id, icon: null })
              : undefined
          }
        />
      )}
      {coverAnchor && (
        <CoverPicker
          anchor={coverAnchor}
          onClose={() => setCoverAnchor(null)}
          onPick={(cover) => void mutations.setCover({ id: page._id, cover })}
        />
      )}
    </div>
  );
}

/**
 * "Linked mentions" — every page whose content links here, Notion-style.
 * Hidden when the page has no backlinks.
 */
function LinkedMentions({ pageId }: { pageId: PageId }) {
  const backlinks = useBacklinks(pageId);
  const { navigate } = useNav();
  const [open, setOpen] = useState(true);

  if (!backlinks || backlinks.length === 0) return null;

  return (
    <div className="backlinks">
      <button className="backlinks-header" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Link2 size={13} />
        <span>
          {backlinks.length} linked mention{backlinks.length === 1 ? "" : "s"}
        </span>
      </button>
      {open &&
        backlinks.map((b) => (
          <button
            key={b._id}
            className="backlink-item"
            onClick={() => navigate(b._id)}
          >
            <span className="backlink-icon">
              {b.icon ? (
                b.icon
              ) : b.type === "database" ? (
                <Database size={14} />
              ) : (
                <FileText size={14} />
              )}
            </span>
            <span className="backlink-title">{b.title || "Untitled"}</span>
          </button>
        ))}
    </div>
  );
}
