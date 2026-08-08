import React, { useEffect, useMemo, useState } from "react";
import {
  Clock,
  Database,
  FileText,
  History,
  LayoutTemplate,
  Lock,
  Navigation,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";
import { PagesIndex, PageMeta } from "../lib/types";
import { LIBRARY_TABS, LibraryTab, libraryRows } from "../lib/library";
import { formatVisitTime, visitTimes } from "../lib/visits";
import { useMutations } from "../data";
import { useNav } from "../state";

const TAB_ICONS: Record<LibraryTab, React.ReactNode> = {
  recents: <History size={15} />,
  favorites: <Star size={15} />,
  private: <Lock size={15} />,
  templates: <LayoutTemplate size={15} />,
};

const EMPTY_HINTS: Record<LibraryTab, string> = {
  recents: "Pages you open will show up here.",
  favorites: "Star a page and it will show up here.",
  private: "No pages yet — create one to get started.",
  templates: "Mark a page as a template and it will show up here.",
};

function PageIcon({ page }: { page: PageMeta }) {
  if (page.icon) return <span className="lib-icon">{page.icon}</span>;
  return (
    <span className="lib-icon dim">
      {page.type === "database" ? <Database size={15} /> : <FileText size={15} />}
    </span>
  );
}

export default function LibraryView({ index }: { index: PagesIndex }) {
  const { navigate } = useNav();
  const mutations = useMutations();
  const [tab, setTab] = useState<LibraryTab>("recents");
  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState("");

  // The departure visit of the page we just left is recorded in an effect
  // cleanup (App.tsx), which runs *after* this view's first render — so
  // snapshot again once mounted, or the freshest visit is one render stale.
  const [visits, setVisits] = useState(() => visitTimes());
  useEffect(() => {
    setVisits(visitTimes());
  }, []);
  const rows = useMemo(
    () => libraryRows(index, tab, visits, term),
    [index, tab, visits, term],
  );

  const newPage = () =>
    void mutations.create({ type: "doc" }).then((id) => navigate(id));

  return (
    <div className="library-view">
      <header className="library-header">
        <h1>Library</h1>
        <button className="btn primary" onClick={newPage}>
          <Plus size={15} /> New page
        </button>
      </header>

      <div className="library-toolbar">
        <div className="library-tabs">
          {LIBRARY_TABS.map((t) => (
            <button
              key={t.key}
              className={`library-tab ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {TAB_ICONS[t.key]} {t.label}
            </button>
          ))}
        </div>
        {searchOpen ? (
          <span className="db-search">
            <Search size={14} />
            <input
              autoFocus
              value={term}
              placeholder="Filter by title…"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setTerm("");
                  setSearchOpen(false);
                }
              }}
            />
            <button
              className="icon-btn small"
              onClick={() => {
                setTerm("");
                setSearchOpen(false);
              }}
            >
              <X size={13} />
            </button>
          </span>
        ) : (
          <button
            className="icon-btn"
            title="Filter by title"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={16} />
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="library-empty">
          {term ? "No pages match." : EMPTY_HINTS[tab]}
        </div>
      ) : (
        <table className="library-table">
          <thead>
            <tr>
              <th>
                <FileText size={13} /> Page name
              </th>
              <th>
                <Navigation size={13} /> Source
              </th>
              <th>
                <Clock size={13} /> Last edited
              </th>
              <th>
                <Clock size={13} /> Last visited
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ page, source, visitedAt }) => (
              <tr key={page._id} onClick={() => navigate(page._id)}>
                <td className="lib-name">
                  <PageIcon page={page} />
                  <span>{page.title || "Untitled"}</span>
                </td>
                <td className="lib-source">
                  {source ? (
                    <button
                      className="lib-source-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(source._id);
                      }}
                    >
                      <PageIcon page={source} />
                      <span>{source.title || "Untitled"}</span>
                    </button>
                  ) : (
                    <span className="lib-source-private">
                      <Lock size={13} /> Private
                    </span>
                  )}
                </td>
                <td className="lib-time">{formatVisitTime(page.updatedAt)}</td>
                <td className="lib-time">
                  {visitedAt ? formatVisitTime(visitedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
