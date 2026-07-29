import React from "react";
import { Plus, X, FileText, Database, ChevronsRight, Layout } from "lucide-react";
import { PagesIndex } from "../lib/types";
import { useNav } from "../state";

interface TabBarProps {
  index: PagesIndex;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
}

export default function TabBar({
  index,
  sidebarCollapsed,
  onExpandSidebar,
}: TabBarProps) {
  const { tabs, activeTabId, selectTab, closeTab, newTab } = useNav();

  return (
    <div className={`tab-bar drag-region ${sidebarCollapsed ? "pad-traffic" : ""}`}>
      {sidebarCollapsed && (
        <button
          className="icon-btn no-drag"
          title="Open sidebar (⌘\)"
          onClick={onExpandSidebar}
        >
          <ChevronsRight size={17} />
        </button>
      )}
      <div className="tab-strip no-drag">
        {tabs.map((tab) => {
          const page = tab.pageId ? index.byId.get(tab.pageId) : undefined;
          const title = tab.pageId
            ? page?.title || "Untitled"
            : "New tab";
          return (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => selectTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id); // middle-click closes
              }}
              title={title}
            >
              <span className="tab-icon">
                {page?.icon ? (
                  page.icon
                ) : page?.type === "database" ? (
                  <Database size={13} />
                ) : tab.pageId ? (
                  <FileText size={13} />
                ) : (
                  <Layout size={13} />
                )}
              </span>
              <span className="tab-title">{title}</span>
              <button
                className="tab-close"
                title="Close tab (⌘W)"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button className="tab-new" title="New tab (⌘T)" onClick={() => newTab()}>
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}
