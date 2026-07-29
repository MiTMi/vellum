import React, { useEffect, useRef, useState } from "react";
import { NavProvider, useNav } from "./state";
import { usePagesIndex } from "./hooks/usePagesIndex";
import { useMutations } from "./data";
import { setRegistry } from "./lib/pageRegistry";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import TabBar from "./components/TabBar";
import PageView from "./components/PageView";
import QuickSwitcher from "./components/QuickSwitcher";
import TrashModal from "./components/TrashModal";
import { FileText, Plus } from "lucide-react";

export default function App() {
  return (
    <NavProvider>
      <Workspace />
    </NavProvider>
  );
}

function Workspace() {
  const index = usePagesIndex();
  const mutations = useMutations();
  const { pageId, navigate, theme, newTab } = useNav();
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const w = Number(localStorage.getItem("vellum:sidebarWidth"));
    return w >= 200 && w <= 440 ? w : 250;
  });
  const bootstrapped = useRef(false);

  useEffect(() => {
    localStorage.setItem("vellum:sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  // Mirror the page index into the module registry for editor blocks.
  useEffect(() => {
    const map = new Map<string, { title: string; icon: string | null; type: "doc" | "database" }>();
    for (const p of index.all) {
      map.set(p._id, { title: p.title, icon: p.icon, type: p.type });
    }
    setRegistry(map);
  }, [index]);

  // First launch: seed the welcome page.
  useEffect(() => {
    if (index.loading || bootstrapped.current) return;
    bootstrapped.current = true;
    if (index.all.length === 0) {
      void mutations.bootstrap().then((id) => {
        if (id) navigate(id);
      });
    }
  }, [index.loading, index.all.length, mutations, navigate]);

  // If the current page disappeared (trashed / deleted), fall back gracefully.
  useEffect(() => {
    if (!index.loading && pageId && !index.byId.has(pageId)) {
      navigate(null);
    }
  }, [index, pageId, navigate]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        void mutations.create({ type: "doc" }).then((id) => navigate(id));
      } else if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newTab();
      } else if (mod && e.key.toLowerCase() === "d" && pageId) {
        e.preventDefault();
        void mutations.duplicate({ id: pageId }).then((id) => {
          if (id) navigate(id);
        });
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mutations, navigate, newTab, pageId]);

  return (
    <div className={`app theme-${theme}`}>
      {!sidebarCollapsed && (
        <Sidebar
          index={index}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenTrash={() => setTrashOpen(true)}
          onCollapse={() => setSidebarCollapsed(true)}
          width={sidebarWidth}
          setWidth={setSidebarWidth}
        />
      )}
      <div className="main-col">
        <TabBar
          index={index}
          sidebarCollapsed={sidebarCollapsed}
          onExpandSidebar={() => setSidebarCollapsed(false)}
        />
        <TopBar index={index} />
        <main className="main-content">
          {pageId && index.byId.has(pageId) ? (
            <PageView pageId={pageId} index={index} />
          ) : (
            <EmptyState
              loading={index.loading}
              onNewPage={() =>
                void mutations.create({ type: "doc" }).then((id) => navigate(id))
              }
            />
          )}
        </main>
      </div>

      {searchOpen && (
        <QuickSwitcher
          index={index}
          onClose={() => setSearchOpen(false)}
          onOpenTrash={() => setTrashOpen(true)}
        />
      )}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} />}
    </div>
  );
}

function EmptyState({
  loading,
  onNewPage,
}: {
  loading: boolean;
  onNewPage: () => void;
}) {
  if (loading) {
    return (
      <div className="empty-state">
        <div className="spinner" />
      </div>
    );
  }
  return (
    <div className="empty-state">
      <FileText size={42} strokeWidth={1.2} />
      <h2>Nothing open</h2>
      <p>Pick a page from the sidebar, or create a new one.</p>
      <button className="btn primary" onClick={onNewPage}>
        <Plus size={15} /> New page
      </button>
    </div>
  );
}
