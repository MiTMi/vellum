import React, { useEffect, useMemo, useState } from "react";
import {
  Table2,
  Kanban,
  Calendar as CalendarIcon,
  LayoutGrid,
  ChevronDown,
  ListFilter,
  ArrowUpDown,
  Search,
  Plus,
  X,
  ChevronLeft,
} from "lucide-react";
import {
  PageDoc,
  PageMeta,
  childrenKey,
  PagesIndex,
  DbProp,
  ViewKind,
} from "../../lib/types";
import { useMutations } from "../../data";
import { requestPeek, useNav } from "../../state";
import {
  applyFilters,
  applySearch,
  applySort,
  Filters,
  groupRows,
  LocalViewState,
  loadViewState,
  saveViewState,
  Sort,
  toDateKey,
} from "../../lib/dbviews";
import TableView from "./TableView";
import BoardView from "./BoardView";
import CalendarView from "./CalendarView";
import GalleryView from "./GalleryView";
import Menu from "../ui/Menu";
import Popover from "../ui/Popover";
import { PROP_TYPE_META } from "./PropertyMenu";

interface DatabaseViewProps {
  page: PageDoc;
  index: PagesIndex;
  locked?: boolean;
}

export default function DatabaseView({ page, index, locked }: DatabaseViewProps) {
  const mutations = useMutations();
  const { navigate } = useNav();
  const dbProps = useMemo(() => page.dbProps ?? [], [page.dbProps]);
  const allRows: PageMeta[] = index.children.get(childrenKey(page._id)) ?? [];
  const view = page.activeView ?? "table";

  const [state, setState] = useState(() => loadViewState(page._id));
  useEffect(() => setState(loadViewState(page._id)), [page._id]);
  const update = (next: LocalViewState) => {
    setState(next);
    saveViewState(page._id, next);
  };

  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const [groupAnchor, setGroupAnchor] = useState<HTMLElement | null>(null);
  const [tableGroupAnchor, setTableGroupAnchor] = useState<HTMLElement | null>(
    null,
  );

  const rows = useMemo(() => {
    let r = applyFilters(allRows, state.filters, dbProps);
    r = applySearch(r, term);
    // byId lets rollup columns resolve their related rows while sorting.
    return applySort(r, state.sort, dbProps, index.byId);
  }, [allRows, state, term, dbProps, index.byId]);

  const selectProps = dbProps.filter((p) => p.type === "select");
  const dateProps = dbProps.filter((p) => p.type === "date");
  const groupableProps = dbProps.filter((p) =>
    ["select", "multiSelect", "checkbox"].includes(p.type),
  );
  const groups = useMemo(
    () => (view === "table" ? groupRows(rows, state.groupBy, dbProps) : null),
    [view, rows, state.groupBy, dbProps],
  );
  const activeFilterEntries = Object.entries(state.filters).filter(
    ([, v]) => v.length > 0,
  );

  const setView = (activeView: ViewKind) =>
    void mutations.setView({ id: page._id, activeView });

  const newRow = async () => {
    const props: Record<string, unknown> = {};
    if (view === "calendar" && dateProps[0]) {
      props[dateProps[0].id] = toDateKey(new Date());
    }
    const id = await mutations.create({
      parentId: page._id,
      type: "doc",
      props: Object.keys(props).length ? props : undefined,
    });
    // Table gets an inline title editor; the other views open the new row.
    if (view !== "table") requestPeek(id);
  };

  const filterLabel = (propId: string, values: string[]): string => {
    const prop = dbProps.find((p) => p.id === propId);
    if (!prop) return "";
    if (prop.type === "checkbox") {
      return values.map((v) => (v === "__checked" ? "Checked" : "Unchecked")).join(", ");
    }
    return values
      .map((v) => prop.options?.find((o) => o.id === v)?.name ?? "")
      .filter(Boolean)
      .join(", ");
  };

  return (
    <div className="database-view">
      <div className="db-toolbar">
        <div className="db-tabs">
          <button
            className={`db-tab ${view === "table" ? "active" : ""}`}
            onClick={() => setView("table")}
          >
            <Table2 size={15} /> Table
          </button>
          <button
            className={`db-tab ${view === "board" ? "active" : ""}`}
            onClick={() => setView("board")}
          >
            <Kanban size={15} /> Board
          </button>
          <button
            className={`db-tab ${view === "calendar" ? "active" : ""}`}
            onClick={() => setView("calendar")}
          >
            <CalendarIcon size={15} /> Calendar
          </button>
          <button
            className={`db-tab ${view === "gallery" ? "active" : ""}`}
            onClick={() => setView("gallery")}
          >
            <LayoutGrid size={15} /> Gallery
          </button>
        </div>
        <div className="db-toolbar-right">
          {view === "board" && selectProps.length > 1 && (
            <button className="btn subtle" onClick={(e) => setGroupAnchor(e.currentTarget)}>
              {dbProps.find((p) => p.id === page.boardGroupBy)?.name ??
                selectProps[0]?.name}
              <ChevronDown size={13} />
            </button>
          )}
          {view === "table" && groupableProps.length > 0 && (
            <button
              className={`btn subtle ${state.groupBy ? "accent" : ""}`}
              onClick={(e) => setTableGroupAnchor(e.currentTarget)}
            >
              {state.groupBy
                ? `Group: ${dbProps.find((p) => p.id === state.groupBy)?.name ?? "—"}`
                : "Group"}
              <ChevronDown size={13} />
            </button>
          )}
          {view === "calendar" && dateProps.length > 1 && (
            <button className="btn subtle" onClick={(e) => setGroupAnchor(e.currentTarget)}>
              {dbProps.find((p) => p.id === page.calendarBy && p.type === "date")?.name ??
                dateProps[0]?.name}
              <ChevronDown size={13} />
            </button>
          )}
          <button
            className={`icon-btn ${activeFilterEntries.length ? "accent" : ""}`}
            title="Filter"
            onClick={(e) => setFilterAnchor(e.currentTarget)}
          >
            <ListFilter size={16} />
          </button>
          <button
            className={`icon-btn ${state.sort ? "accent" : ""}`}
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

      {(activeFilterEntries.length > 0 || state.sort) && (
        <div className="db-active-bar">
          {state.sort && (
            <span className="db-chip">
              <ArrowUpDown size={12} />
              {state.sort.key === "__title"
                ? "Name"
                : dbProps.find((p) => p.id === state.sort!.key)?.name}
              {state.sort.dir === "asc" ? " ↑" : " ↓"}
              <button onClick={() => update({ ...state, sort: null })}>
                <X size={12} />
              </button>
            </span>
          )}
          {activeFilterEntries.map(([propId, values]) => (
            <span key={propId} className="db-chip">
              <ListFilter size={12} />
              {dbProps.find((p) => p.id === propId)?.name}: {filterLabel(propId, values)}
              <button
                onClick={() =>
                  update({
                    ...state,
                    filters: { ...state.filters, [propId]: [] },
                  })
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <span className="db-count">
            {rows.length} of {allRows.length}
          </span>
        </div>
      )}

      {view === "table" && (
        <TableView
          page={page}
          rows={rows}
          groups={groups}
          groupBy={state.groupBy}
          collapsedGroups={state.collapsedGroups}
          toggleGroup={(key) =>
            update({
              ...state,
              collapsedGroups: state.collapsedGroups.includes(key)
                ? state.collapsedGroups.filter((k) => k !== key)
                : [...state.collapsedGroups, key],
            })
          }
          sort={state.sort}
          setSort={(sort) => update({ ...state, sort })}
          locked={locked}
        />
      )}
      {view === "board" && <BoardView page={page} rows={rows} locked={locked} />}
      {view === "calendar" && <CalendarView page={page} rows={rows} locked={locked} />}
      {view === "gallery" && <GalleryView page={page} rows={rows} locked={locked} />}

      {groupAnchor && view === "board" && (
        <Menu
          anchor={groupAnchor}
          onClose={() => setGroupAnchor(null)}
          items={selectProps.map((p) => ({
            label: p.name,
            onClick: () => void mutations.setView({ id: page._id, boardGroupBy: p.id }),
          }))}
        />
      )}
      {groupAnchor && view === "calendar" && (
        <Menu
          anchor={groupAnchor}
          onClose={() => setGroupAnchor(null)}
          items={dateProps.map((p) => ({
            label: p.name,
            onClick: () => void mutations.setView({ id: page._id, calendarBy: p.id }),
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
              onClick: () =>
                update({ ...state, groupBy: p.id, collapsedGroups: [] }),
            })),
            {
              label: "No grouping",
              onClick: () =>
                update({ ...state, groupBy: null, collapsedGroups: [] }),
            },
          ]}
        />
      )}
      {filterAnchor && (
        <FilterMenu
          anchor={filterAnchor}
          onClose={() => setFilterAnchor(null)}
          dbProps={dbProps}
          filters={state.filters}
          setFilters={(filters) => update({ ...state, filters })}
        />
      )}
      {sortAnchor && (
        <SortMenu
          anchor={sortAnchor}
          onClose={() => setSortAnchor(null)}
          dbProps={dbProps}
          sort={state.sort}
          setSort={(sort) => update({ ...state, sort })}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FilterMenu({
  anchor,
  onClose,
  dbProps,
  filters,
  setFilters,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  dbProps: DbProp[];
  filters: Filters;
  setFilters: (f: Filters) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const filterable = dbProps.filter((p) =>
    ["select", "multiSelect", "checkbox"].includes(p.type),
  );
  const prop = filterable.find((p) => p.id === picked);

  const toggle = (propId: string, value: string) => {
    const current = filters[propId] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    setFilters({ ...filters, [propId]: next });
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={250} align="right" className="menu">
      {!prop ? (
        <>
          <div className="prop-menu-label">Filter by</div>
          {filterable.map((p) => (
            <button key={p.id} className="menu-item" onClick={() => setPicked(p.id)}>
              <span className="menu-icon">{PROP_TYPE_META[p.type].icon}</span>
              <span>{p.name}</span>
              {(filters[p.id]?.length ?? 0) > 0 && (
                <span className="menu-badge">{filters[p.id].length}</span>
              )}
            </button>
          ))}
          {filterable.length === 0 && (
            <div className="select-empty">Add a select or checkbox property to filter.</div>
          )}
        </>
      ) : (
        <>
          <button className="menu-item" onClick={() => setPicked(null)}>
            <span className="menu-icon">
              <ChevronLeft size={15} />
            </span>
            <span>{prop.name}</span>
          </button>
          <div className="menu-divider" />
          {prop.type === "checkbox" ? (
            <>
              {["__checked", "__unchecked"].map((v) => (
                <button key={v} className="menu-item" onClick={() => toggle(prop.id, v)}>
                  <input type="checkbox" readOnly checked={(filters[prop.id] ?? []).includes(v)} />
                  <span>{v === "__checked" ? "Checked" : "Unchecked"}</span>
                </button>
              ))}
            </>
          ) : (
            (prop.options ?? []).map((o) => (
              <button key={o.id} className="menu-item" onClick={() => toggle(prop.id, o.id)}>
                <input type="checkbox" readOnly checked={(filters[prop.id] ?? []).includes(o.id)} />
                <span className={`chip chip-${o.color}`}>{o.name}</span>
              </button>
            ))
          )}
        </>
      )}
    </Popover>
  );
}

function SortMenu({
  anchor,
  onClose,
  dbProps,
  sort,
  setSort,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  dbProps: DbProp[];
  sort: Sort;
  setSort: (s: Sort) => void;
}) {
  const entries: { key: string; name: string }[] = [
    { key: "__title", name: "Name" },
    ...dbProps.map((p) => ({ key: p.id, name: p.name })),
  ];
  const cycle = (key: string) => {
    if (sort?.key !== key) setSort({ key, dir: "asc" });
    else if (sort.dir === "asc") setSort({ key, dir: "desc" });
    else setSort(null);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={230} align="right" className="menu">
      <div className="prop-menu-label">Sort by</div>
      {entries.map((e) => (
        <button key={e.key} className="menu-item" onClick={() => cycle(e.key)}>
          <span>{e.name}</span>
          {sort?.key === e.key && (
            <span className="menu-badge">{sort.dir === "asc" ? "↑ A→Z" : "↓ Z→A"}</span>
          )}
        </button>
      ))}
      {sort && (
        <>
          <div className="menu-divider" />
          <button
            className="menu-item"
            onClick={() => {
              setSort(null);
              onClose();
            }}
          >
            <span className="menu-icon">
              <X size={15} />
            </span>
            <span>Clear sort</span>
          </button>
        </>
      )}
    </Popover>
  );
}
