import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageId } from "./lib/types";
import { uid } from "./lib/ranks";

export type Theme = "light" | "dark";

export interface Tab {
  id: string;
  pageId: PageId | null;
}

interface NavState {
  pageId: PageId | null;
  canBack: boolean;
  canForward: boolean;
  navigate: (id: PageId | null) => void;
  back: () => void;
  forward: () => void;
  theme: Theme;
  toggleTheme: () => void;
  tabs: Tab[];
  activeTabId: string;
  newTab: (pageId?: PageId | null) => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
}

const NavContext = createContext<NavState | null>(null);

export function useNav(): NavState {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav outside provider");
  return ctx;
}

/* Custom blocks inside the editor can't easily reach React context, so we
   also expose navigation through a window event. */
export function requestNavigate(id: string) {
  window.dispatchEvent(new CustomEvent("vellum:navigate", { detail: id }));
}

function initialTheme(): Theme {
  const saved = localStorage.getItem("vellum:theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

interface PersistedTabs {
  tabs: Tab[];
  activeTabId: string;
}

function initialTabs(): PersistedTabs {
  try {
    const raw = localStorage.getItem("vellum:tabs");
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedTabs;
      if (parsed.tabs?.length) {
        if (!parsed.tabs.some((t) => t.id === parsed.activeTabId)) {
          parsed.activeTabId = parsed.tabs[0].id;
        }
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  const first: Tab = {
    id: uid(),
    pageId: (localStorage.getItem("vellum:lastPage") as PageId | null) ?? null,
  };
  return { tabs: [first], activeTabId: first.id };
}

interface History {
  back: (PageId | null)[];
  fwd: (PageId | null)[];
}

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [{ tabs, activeTabId }, setTabState] = useState<PersistedTabs>(initialTabs);
  const histories = useRef<Record<string, History>>({});
  const [, bump] = useState(0);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const pageId = active?.pageId ?? null;

  const historyOf = (id: string): History => {
    if (!histories.current[id]) histories.current[id] = { back: [], fwd: [] };
    return histories.current[id];
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("vellum:theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("vellum:tabs", JSON.stringify({ tabs, activeTabId }));
    if (pageId) localStorage.setItem("vellum:lastPage", pageId);
  }, [tabs, activeTabId, pageId]);

  const navigate = useCallback(
    (id: PageId | null) => {
      setTabState((prev) => {
        const cur = prev.tabs.find((t) => t.id === prev.activeTabId);
        if (!cur || cur.pageId === id) return prev;
        const h = historyOf(prev.activeTabId);
        h.back.push(cur.pageId);
        h.fwd = [];
        return {
          ...prev,
          tabs: prev.tabs.map((t) =>
            t.id === prev.activeTabId ? { ...t, pageId: id } : t,
          ),
        };
      });
      bump((n) => n + 1);
    },
    [],
  );

  const back = useCallback(() => {
    setTabState((prev) => {
      const h = historyOf(prev.activeTabId);
      if (!h.back.length) return prev;
      const cur = prev.tabs.find((t) => t.id === prev.activeTabId);
      if (!cur) return prev;
      const target = h.back.pop()!;
      h.fwd.push(cur.pageId);
      return {
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === prev.activeTabId ? { ...t, pageId: target } : t,
        ),
      };
    });
    bump((n) => n + 1);
  }, []);

  const forward = useCallback(() => {
    setTabState((prev) => {
      const h = historyOf(prev.activeTabId);
      if (!h.fwd.length) return prev;
      const cur = prev.tabs.find((t) => t.id === prev.activeTabId);
      if (!cur) return prev;
      const target = h.fwd.pop()!;
      h.back.push(cur.pageId);
      return {
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === prev.activeTabId ? { ...t, pageId: target } : t,
        ),
      };
    });
    bump((n) => n + 1);
  }, []);

  const newTab = useCallback((tabPageId: PageId | null = null) => {
    const tab: Tab = { id: uid(), pageId: tabPageId };
    setTabState((prev) => ({
      tabs: [...prev.tabs, tab],
      activeTabId: tab.id,
    }));
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabState((prev) => {
      delete histories.current[id];
      const idx = prev.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const remaining = prev.tabs.filter((t) => t.id !== id);
      if (!remaining.length) {
        // Last tab: reset it instead of leaving the window empty.
        const fresh: Tab = { id: uid(), pageId: null };
        return { tabs: [fresh], activeTabId: fresh.id };
      }
      let activeId = prev.activeTabId;
      if (activeId === id) {
        activeId = (remaining[idx - 1] ?? remaining[0]).id;
      }
      return { tabs: remaining, activeTabId: activeId };
    });
  }, []);

  const selectTab = useCallback((id: string) => {
    setTabState((prev) =>
      prev.tabs.some((t) => t.id === id) ? { ...prev, activeTabId: id } : prev,
    );
  }, []);

  useEffect(() => {
    const onNav = (e: Event) => {
      navigate((e as CustomEvent<string>).detail as PageId);
    };
    // A page created offline was assigned its real Convex id by the sync
    // engine — swap the temp id everywhere navigation state holds one.
    const onRemap = (e: Event) => {
      const { from, to } = (e as CustomEvent<{ from: string; to: string }>)
        .detail;
      const toId = to as PageId;
      setTabState((prev) =>
        prev.tabs.some((t) => t.pageId === from)
          ? {
              ...prev,
              tabs: prev.tabs.map((t) =>
                t.pageId === from ? { ...t, pageId: toId } : t,
              ),
            }
          : prev,
      );
      for (const h of Object.values(histories.current)) {
        h.back = h.back.map((p) => (p === from ? toId : p));
        h.fwd = h.fwd.map((p) => (p === from ? toId : p));
      }
      if (localStorage.getItem("vellum:lastPage") === from) {
        localStorage.setItem("vellum:lastPage", to);
      }
    };
    const onNewTab = () => newTab();
    const onCloseTab = () => {
      setTabState((prev) => {
        // Close active; if it was the only tab, ask Electron to close the window.
        if (prev.tabs.length <= 1) {
          window.close();
          return prev;
        }
        return prev;
      });
      // Delegate the multi-tab case to closeTab (reads freshest state).
      closeTabActiveRef.current();
    };
    window.addEventListener("vellum:navigate", onNav);
    window.addEventListener("vellum:id-remapped", onRemap);
    window.addEventListener("vellum:new-tab", onNewTab);
    window.addEventListener("vellum:close-tab", onCloseTab);
    return () => {
      window.removeEventListener("vellum:navigate", onNav);
      window.removeEventListener("vellum:id-remapped", onRemap);
      window.removeEventListener("vellum:new-tab", onNewTab);
      window.removeEventListener("vellum:close-tab", onCloseTab);
    };
  }, [navigate, newTab, closeTab]);

  // Ref so the close-tab event handler always closes the *current* active tab.
  const closeTabActiveRef = useRef(() => {});
  useEffect(() => {
    closeTabActiveRef.current = () => {
      if (tabs.length > 1) closeTab(activeTabId);
    };
  }, [tabs, activeTabId, closeTab]);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "light" ? "dark" : "light")),
    [],
  );

  const h = historyOf(activeTabId);
  const value = useMemo<NavState>(
    () => ({
      pageId,
      canBack: h.back.length > 0,
      canForward: h.fwd.length > 0,
      navigate,
      back,
      forward,
      theme,
      toggleTheme,
      tabs,
      activeTabId,
      newTab,
      closeTab,
      selectTab,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageId, navigate, back, forward, theme, toggleTheme, tabs, activeTabId,
     newTab, closeTab, selectTab, h.back.length, h.fwd.length],
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
