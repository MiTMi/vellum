import React, { useEffect, useMemo, useState } from "react";
import {
  Table2,
  Kanban,
  Calendar as CalendarIcon,
  LayoutGrid,
  GanttChart,
  ChevronDown,
  ListFilter,
  ArrowUpDown,
  Search,
  Plus,
  X,
  Copy,
  Trash2,
} from "lucide-react";
import {
  PageDoc,
  PageMeta,
  childrenKey,
  PagesIndex,
  DbProp,
  DbView,
  SortRule,
  ViewKind,
} from "../../lib/types";
import { useMutations } from "../../data";
import { requestPeek } from "../../state";
import {
  applyFilterGroup,
  applySearch,
  applySorts,
  countFilterRules,
  groupRows,
  LocalViewState,
  loadViewState,
  newViewId,
  saveViewState,
  toDateKey,
  VIEW_KIND_LABELS,
  VIEW_KINDS,
  viewsOf,
} from "../../lib/dbviews";
import TableView from "./TableView";
import BoardView from "./BoardView";
import CalendarView from "./CalendarView";
import GalleryView from "./GalleryView";
import TimelineView from "./TimelineView";
import Menu from "../ui/Menu";
import Popover from "../ui/Popover";
import FilterBuilder from "./FilterBuilder";

interface DatabaseViewProps {
  page: PageDoc;
  index: PagesIndex;
  locked?: boolean;
}

const KIND_ICONS: Record<ViewKind, React.ReactNode> = {
  table: <Table2 size={15} />,
  board: <Kanban size={15} />,
  calendar: <CalendarIcon size={15} />,
  gallery: <LayoutGrid size={15} />,
  timeline: <GanttChart size={15} />,
};

export default function DatabaseView({ page, index, locked }: DatabaseViewProps) {
  const mutations = useMutations();
  const dbProps = useMemo(() => page.dbProps ?? [], [page.dbProps]);
  const allRows: PageMeta[] = index.children.get(childrenKey(page._id)) ?? [];

  // Per-device state: selected tab + collapsed groups. The legacy
  // filter/sort keys ride along untouched — they seed derived views.
  const [local, setLocal] = useState(() => loadViewState(page._id));
  useEffect(() => setLocal(loadViewState(page._id)), [page._id]);
  const saveLocal = (next: LocalViewState) => {
    setLocal(next);
    saveViewState(page._id, next);
  };

  const { views, derived } = useMemo(
    () => viewsOf(page, dbProps, local),
    [page, dbProps, local],
  );
  const view =
    views.find((v) => v.id === local.activeViewId) ??
    (derived
      ? (views.find((v) => v.kind === (page.activeView ?? "table")) ?? views[0])
      : views[0]);

  /** Persist the whole view array — materializes derived views on first edit. */
  const commitViews = (next: DbView[]) =>
    void mutations.setViews({ id: page._id, views: next });
  const updateView = (patch: Partial<DbView>) =>
    commitViews(views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)));

  const selectTab = (v: DbView) => {
    saveLocal({ ...local, activeViewId: v.id, collapsedGroups: [] });
    // Pre-materialization the old synced field still drives other devices'
    // default tab; once `views` exists it's a read-only fallback.
    if (derived) void mutations.setView({ id: page._id, activeView: v.kind });
  };

  const uniqueName = (base: string) => {
    let name = base;
    for (let n = 2; views.some((v) => v.name === name); n++) {
      name = `${base} ${n}`;
    }
    return name;
  };

  const addView = (kind: ViewKind) => {
    const next: DbView = {
      id: newViewId(),
      name: uniqueName(VIEW_KIND_LABELS[kind]),
      kind,
    };
    commitViews([...views, next]);
    saveLocal({ ...local, activeViewId: next.id, collapsedGroups: [] });
  };

  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const [groupAnchor, setGroupAnchor] = useState<HTMLElement | null>(null);
  const [tableGroupAnchor, setTableGroupAnchor] = useState<HTMLElement | null>(
    null,
  );
  const [viewMenuAnchor, setViewMenuAnchor] = useState<HTMLElement | null>(null);
  const [addViewAnchor, setAddViewAnchor] = useState<HTMLElement | null>(null);

  const sorts = view.sorts ?? [];
  const filterCount = countFilterRules(view.filter);

  const rows = useMemo(() => {
    let r = applyFilterGroup(allRows, view.filter, dbProps, index.byId);
    r = applySearch(r, term);
    // byId lets rollup columns resolve their related rows while sorting.
    return applySorts(r, view.sorts ?? [], dbProps, index.byId);
  }, [allRows, view.filter, view.sorts, term, dbProps, index.byId]);

  const selectProps = dbProps.filter((p) => p.type === "select");
  const dateProps = dbProps.filter((p) => p.type === "date");
  const groupableProps = dbProps.filter((p) =>
    ["select", "multiSelect", "checkbox"].includes(p.type),
  );
  const groups = useMemo(
    () =>
      view.kind === "table"
        ? groupRows(rows, view.groupBy ?? null, dbProps)
        : null,
    [view.kind, rows, view.groupBy, dbProps],
  );

  const newRow = async () => {
    const props: Record<string, unknown> = {};
    if (view.kind === "calendar" && dateProps[0]) {
      props[dateProps[0].id] = toDateKey(new Date());
    }
    const id = await mutations.create({
      parentId: page._id,
      type: "doc",
      props: Object.keys(props).length ? props : undefined,
    });
    // Table gets an inline title editor; the other views open the new row.
    if (view.kind !== "table") requestPeek(id);
  };

  const sortName = (key: string) =>
    key === "__title" ? "Name" : (dbProps.find((p) => p.id === key)?.name ?? "—");

  return (
    <div className="database-view">
      <div className="db-toolbar">
        <div className="db-tabs">
          {views.map((v) => (
            <button
              key={v.id}
              className={`db-tab ${v.id === view.id ? "active" : ""}`}
              onClick={(e) => {
                if (v.id === view.id) setViewMenuAnchor(e.currentTarget);
                else selectTab(v);
              }}
            >
              {KIND_ICONS[v.kind]} {v.name}
            </button>
          ))}
          <button
            className="db-tab db-add-view"
            title="Add view"
            onClick={(e) => setAddViewAnchor(e.currentTarget)}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="db-toolbar-right">
          {view.kind === "board" && selectProps.length > 1 && (
            <button className="btn subtle" onClick={(e) => setGroupAnchor(e.currentTarget)}>
              {dbProps.find((p) => p.id === view.boardGroupBy)?.name ??
                selectProps[0]?.name}
              <ChevronDown size={13} />
            </button>
          )}
          {view.kind === "table" && groupableProps.length > 0 && (
            <button
              className={`btn subtle ${view.groupBy ? "accent" : ""}`}
              onClick={(e) => setTableGroupAnchor(e.currentTarget)}
            >
              {view.groupBy
                ? `Group: ${dbProps.find((p) => p.id === view.groupBy)?.name ?? "—"}`
                : "Group"}
              <ChevronDown size={13} />
            </button>
          )}
          {(view.kind === "timeline" || view.kind === "calendar") &&
            dateProps.length > 1 && (
              <button className="btn subtle" onClick={(e) => setGroupAnchor(e.currentTarget)}>
                {dbProps.find((p) => p.id === view.calendarBy && p.type === "date")
                  ?.name ?? dateProps[0]?.name}
                <ChevronDown size={13} />
              </button>
            )}
          <button
            className={`icon-btn ${filterCount ? "accent" : ""}`}
            title="Filter"
            onClick={(e) => setFilterAnchor(e.currentTarget)}
          >
            <ListFilter size={16} />
          </button>
          <button
            className={`icon-btn ${sorts.length ? "accent" : ""}`}
            title="Sort"
            onClick={(e) => setSortAnchor(e.currentTarget)}
          >
            <ArrowUpDown size={15} />
          </button>
          {searchOpen ? (
            <span className="db-search">
              <Search size={14} />
              <input
                autoFocus
                value={term}
                placeholder="Search rows…"
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
              title="Search in database"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} />
            </button>
          )}
          {!locked && (
            <button className="btn primary db-new" onClick={() => void newRow()}>
              <Plus size={14} /> New
            </button>
          )}
        </div>
      </div>

      {(filterCount > 0 || sorts.length > 0) && (
        <div className="db-active-bar">
          {sorts.map((rule) => (
            <span key={rule.key} className="db-chip">
              <ArrowUpDown size={12} />
              {sortName(rule.key)}
              {rule.dir === "asc" ? " ↑" : " ↓"}
              <button
                onClick={() =>
                  updateView({ sorts: sorts.filter((s) => s.key !== rule.key) })
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {filterCount > 0 && (
            <span className="db-chip">
              <ListFilter size={12} />
              {filterCount === 1 ? "1 filter" : `${filterCount} filters`}
              <button onClick={() => updateView({ filter: undefined })}>
                <X size={12} />
              </button>
            </span>
          )}
          <span className="db-count">
            {rows.length} of {allRows.length}
          </span>
        </div>
      )}

      {view.kind === "table" && (
        <TableView
          page={page}
          rows={rows}
          groups={groups}
          groupBy={view.groupBy ?? null}
          collapsedGroups={local.collapsedGroups}
          toggleGroup={(key) =>
            saveLocal({
              ...local,
              collapsedGroups: local.collapsedGroups.includes(key)
                ? local.collapsedGroups.filter((k) => k !== key)
                : [...local.collapsedGroups, key],
            })
          }
          sort={sorts[0] ?? null}
          setSort={(sort) => updateView({ sorts: sort ? [sort] : [] })}
          locked={locked}
        />
      )}
      {view.kind === "board" && (
        <BoardView page={page} view={view} rows={rows} locked={locked} />
      )}
      {view.kind === "calendar" && (
        <CalendarView page={page} view={view} rows={rows} locked={locked} />
      )}
      {view.kind === "gallery" && (
        <GalleryView page={page} rows={rows} locked={locked} />
      )}
      {view.kind === "timeline" && (
        <TimelineView page={page} view={view} rows={rows} locked={locked} />
      )}

      {groupAnchor && view.kind === "board" && (
        <Menu
          anchor={groupAnchor}
          onClose={() => setGroupAnchor(null)}
          items={selectProps.map((p) => ({
            label: p.name,
            onClick: () => updateView({ boardGroupBy: p.id }),
          }))}
        />
      )}
      {groupAnchor && (view.kind === "timeline" || view.kind === "calendar") && (
        <Menu
          anchor={groupAnchor}
          onClose={() => setGroupAnchor(null)}
          items={dateProps.map((p) => ({
            label: p.name,
            onClick: () => updateView({ calendarBy: p.id }),
          }))}
        />
      )}
      {tableGroupAnchor && (
        <Menu
          anchor={tableGroupAnchor}
          onClose={() => setTableGroupAnchor(null)}
          items={[
            ...groupableProps.map((p) => ({
              label: p.name,
              onClick: () => {
                updateView({ groupBy: p.id });
                saveLocal({ ...local, collapsedGroups: [] });
              },
            })),
            {
              label: "No grouping",
              onClick: () => {
                updateView({ groupBy: undefined });
                saveLocal({ ...local, collapsedGroups: [] });
              },
            },
          ]}
        />
      )}
      {filterAnchor && (
        <FilterBuilder
          anchor={filterAnchor}
          onClose={() => setFilterAnchor(null)}
          dbProps={dbProps}
          filter={view.filter}
          setFilter={(filter) => updateView({ filter })}
        />
      )}
      {sortAnchor && (
        <SortMenu
          anchor={sortAnchor}
          onClose={() => setSortAnchor(null)}
          dbProps={dbProps}
          sorts={sorts}
          setSorts={(next) => updateView({ sorts: next })}
        />
      )}
      {viewMenuAnchor && (
        <ViewMenu
          anchor={viewMenuAnchor}
          onClose={() => setViewMenuAnchor(null)}
          view={view}
          canDelete={views.length > 1}
          rename={(name) => updateView({ name })}
          setKind={(kind) => updateView({ kind })}
          duplicate={() => {
            const copy: DbView = {
              ...view,
              id: newViewId(),
              name: uniqueName(view.name),
            };
            const i = views.findIndex((v) => v.id === view.id);
            commitViews([...views.slice(0, i + 1), copy, ...views.slice(i + 1)]);
            saveLocal({ ...local, activeViewId: copy.id });
          }}
          remove={() => {
            const rest = views.filter((v) => v.id !== view.id);
            commitViews(rest);
            saveLocal({
              ...local,
              activeViewId: rest[0]?.id ?? null,
              collapsedGroups: [],
            });
          }}
        />
      )}
      {addViewAnchor && (
        <Menu
          anchor={addViewAnchor}
          onClose={() => setAddViewAnchor(null)}
          items={VIEW_KINDS.map((kind) => ({
            label: VIEW_KIND_LABELS[kind],
            onClick: () => addView(kind),
          }))}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Settings for the active view: rename, layout, duplicate, delete. */
function ViewMenu({
  anchor,
  onClose,
  view,
  canDelete,
  rename,
  setKind,
  duplicate,
  remove,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  view: DbView;
  canDelete: boolean;
  rename: (name: string) => void;
  setKind: (kind: ViewKind) => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const [name, setName] = useState(view.name);
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== view.name) rename(trimmed);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={240} className="menu view-menu">
      <input
        className="view-menu-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitName();
            onClose();
          }
        }}
      />
      <div className="prop-menu-label">Layout</div>
      <div className="view-menu-kinds">
        {VIEW_KINDS.map((kind) => (
          <button
            key={kind}
            className={`view-kind ${view.kind === kind ? "active" : ""}`}
            title={VIEW_KIND_LABELS[kind]}
            onClick={() => setKind(kind)}
          >
            {KIND_ICONS[kind]}
            <span>{VIEW_KIND_LABELS[kind]}</span>
          </button>
        ))}
      </div>
      <div className="menu-divider" />
      <button
        className="menu-item"
        onClick={() => {
          duplicate();
          onClose();
        }}
      >
        <span className="menu-icon">
          <Copy size={15} />
        </span>
        <span>Duplicate view</span>
      </button>
      {canDelete && (
        <button
          className="menu-item danger"
          onClick={() => {
            remove();
            onClose();
          }}
        >
          <span className="menu-icon">
            <Trash2 size={15} />
          </span>
          <span>Delete view</span>
        </button>
      )}
    </Popover>
  );
}

/** Multi-sort: click cycles asc → desc → off; order of addition wins. */
function SortMenu({
  anchor,
  onClose,
  dbProps,
  sorts,
  setSorts,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  dbProps: DbProp[];
  sorts: SortRule[];
  setSorts: (s: SortRule[]) => void;
}) {
  const entries: { key: string; name: string }[] = [
    { key: "__title", name: "Name" },
    ...dbProps.map((p) => ({ key: p.id, name: p.name })),
  ];
  const cycle = (key: string) => {
    const i = sorts.findIndex((s) => s.key === key);
    if (i === -1) setSorts([...sorts, { key, dir: "asc" }]);
    else if (sorts[i].dir === "asc") {
      setSorts(sorts.map((s, j) => (j === i ? { ...s, dir: "desc" } : s)));
    } else setSorts(sorts.filter((_, j) => j !== i));
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={230} align="right" className="menu">
      <div className="prop-menu-label">Sort by</div>
      {entries.map((e) => {
        const i = sorts.findIndex((s) => s.key === e.key);
        return (
          <button key={e.key} className="menu-item" onClick={() => cycle(e.key)}>
            <span>{e.name}</span>
            {i !== -1 && (
              <span className="menu-badge">
                {sorts.length > 1 ? `${i + 1} · ` : ""}
                {sorts[i].dir === "asc" ? "↑ A→Z" : "↓ Z→A"}
              </span>
            )}
          </button>
        );
      })}
      {sorts.length > 0 && (
        <>
          <div className="menu-divider" />
          <button
            className="menu-item"
            onClick={() => {
              setSorts([]);
              onClose();
            }}
          >
            <span className="menu-icon">
              <X size={15} />
            </span>
            <span>Clear sorts</span>
          </button>
        </>
      )}
    </Popover>
  );
}
