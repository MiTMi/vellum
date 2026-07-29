import React, { useMemo, useRef, useState } from "react";
import {
  Plus,
  ArrowUpRight,
  Trash2,
  GripVertical,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { DbProp, PageDoc, PageMeta, PageId, SelectOption } from "../../lib/types";
import { useMutations } from "../../data";
import { requestPeek, useNav } from "../../state";
import Cell from "./Cell";
import PropertyMenu, { PROP_TYPE_META } from "./PropertyMenu";
import { uid } from "../../lib/ranks";

import { RowGroup, Sort } from "../../lib/dbviews";

interface TableViewProps {
  page: PageDoc;
  rows: PageMeta[];
  /** Non-null when the view is grouped; rows are then rendered per group. */
  groups?: RowGroup[] | null;
  groupBy?: string | null;
  collapsedGroups?: string[];
  toggleGroup?: (key: string) => void;
  sort: Sort;
  setSort: (s: Sort) => void;
  locked?: boolean;
}

export default function TableView({
  page,
  rows,
  groups,
  groupBy,
  collapsedGroups = [],
  toggleGroup,
  sort,
  setSort,
  locked,
}: TableViewProps) {
  const mutations = useMutations();
  const { navigate } = useNav();
  const dbProps = useMemo(() => page.dbProps ?? [], [page.dbProps]);
  const [menuFor, setMenuFor] = useState<{ propId: string; anchor: HTMLElement } | null>(null);
  const [titleEdit, setTitleEdit] = useState<{ id: PageId; value: string } | null>(null);
  const widthsRef = useRef<Record<string, number>>({});

  const sorted = rows; // sorting/filtering happens in DatabaseView

  const saveProps = (next: DbProp[]) =>
    void mutations.updateDbProps({ id: page._id, dbProps: next });

  const addOption = (propId: string, option: SelectOption) => {
    saveProps(
      dbProps.map((p) =>
        p.id === propId ? { ...p, options: [...(p.options ?? []), option] } : p,
      ),
    );
  };

  const addProperty = () => {
    saveProps([
      ...dbProps,
      { id: uid(), name: `Property ${dbProps.length + 1}`, type: "text" },
    ]);
  };

  const startResize = (e: React.MouseEvent, prop: DbProp) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = prop.width ?? 170;
    const th = (e.currentTarget as HTMLElement).closest("th");
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(90, startW + ev.clientX - startX);
      widthsRef.current[prop.id] = w;
      if (th) (th as HTMLElement).style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const w = widthsRef.current[prop.id];
      if (w && w !== prop.width) {
        saveProps(dbProps.map((p) => (p.id === prop.id ? { ...p, width: w } : p)));
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const newRow = async () => {
    const id = await mutations.create({ parentId: page._id, type: "doc" });
    setTitleEdit({ id, value: "" });
  };

  const commitTitle = () => {
    if (!titleEdit) return;
    void mutations.rename({ id: titleEdit.id, title: titleEdit.value.trim() });
    setTitleEdit(null);
  };

  return (
    <div className="table-view">
      <table className="db-table">
        <thead>
          <tr>
            <th className="col-title" style={{ width: 280 }}>
              <span className="th-label">Name</span>
            </th>
            {dbProps.map((prop) => (
              <th key={prop.id} style={{ width: prop.width ?? 170 }}>
                <button
                  className="th-btn"
                  onClick={(e) =>
                    setMenuFor({ propId: prop.id, anchor: e.currentTarget })
                  }
                >
                  <span className="th-type-icon">{PROP_TYPE_META[prop.type].icon}</span>
                  <span className="th-label">{prop.name}</span>
                  {sort?.key === prop.id && (
                    <span className="sort-badge">{sort.dir === "asc" ? "↑" : "↓"}</span>
                  )}
                </button>
                <span
                  className="col-resizer"
                  onMouseDown={(e) => startResize(e, prop)}
                />
              </th>
            ))}
            <th className="col-add">
              {!locked && (
                <button className="th-btn add" onClick={addProperty} title="Add property">
                  <Plus size={15} />
                </button>
              )}
            </th>
          </tr>
        </thead>
        {groups
          ? groups.map((g) => (
              <tbody key={g.key} className="db-group">
                <tr className="group-row">
                  <td colSpan={dbProps.length + 2}>
                    <button
                      className="group-toggle"
                      onClick={() => toggleGroup?.(g.key)}
                    >
                      {collapsedGroups.includes(g.key) ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                      <span className={`chip chip-${g.color}`}>{g.label}</span>
                      <span className="board-count">{g.rows.length}</span>
                    </button>
                    {!locked && (
                      <button
                        className="icon-btn small group-add"
                        title={`New row in ${g.label}`}
                        onClick={() => void newRowInGroup(g)}
                      >
                        <Plus size={13} />
                      </button>
                    )}
                  </td>
                </tr>
                {!collapsedGroups.includes(g.key) &&
                  // A multi-select row shows under each of its values, so the
                  // key has to include the group.
                  g.rows.map((row) => renderRow(row, g.key))}
              </tbody>
            ))
          : <tbody>{sorted.map((row) => renderRow(row))}</tbody>}
      </table>

      {!locked && !groups && (
        <button className="new-row-btn" onClick={() => void newRow()}>
          <Plus size={15} /> New
        </button>
      )}

      <div className="table-footer">
        <span>{rows.length} {rows.length === 1 ? "row" : "rows"}</span>
        {sort && (
          <button className="btn subtle" onClick={() => setSort(null)}>
            Clear sort
          </button>
        )}
      </div>

      {menuFor && (
        <PropertyMenu
          anchor={menuFor.anchor}
          onClose={() => setMenuFor(null)}
          prop={dbProps.find((p) => p.id === menuFor.propId)!}
          dbProps={dbProps}
          update={(next) =>
            saveProps(dbProps.map((p) => (p.id === next.id ? next : p)))
          }
          remove={() => saveProps(dbProps.filter((p) => p.id !== menuFor.propId))}
          sort={(dir) =>
            setSort(dir ? { key: menuFor.propId, dir } : null)
          }
        />
      )}
    </div>
  );

  function renderRow(row: PageMeta, groupKey?: string) {
    return (
            <tr key={groupKey ? `${groupKey}:${row._id}` : row._id}>
              <td className="col-title">
                <div className="title-cell">
                  <span className="row-drag">
                    <GripVertical size={13} />
                  </span>
                  <span className="row-icon">{row.icon ?? "📄"}</span>
                  {titleEdit?.id === row._id ? (
                    <input
                      className="cell-input title"
                      autoFocus
                      value={titleEdit.value}
                      onChange={(e) =>
                        setTitleEdit({ id: row._id, value: e.target.value })
                      }
                      onBlur={commitTitle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitTitle();
                        if (e.key === "Escape") setTitleEdit(null);
                      }}
                    />
                  ) : (
                    <span
                      className="row-title"
                      onClick={() => setTitleEdit({ id: row._id, value: row.title })}
                    >
                      {row.title || <span className="cell-placeholder">Untitled</span>}
                    </span>
                  )}
                  <button
                    className="open-btn"
                    onClick={() => requestPeek(row._id)}
                    title="Open as page"
                  >
                    <ArrowUpRight size={13} /> Open
                  </button>
                  <button
                    className="row-delete"
                    title="Delete row"
                    onClick={() => void mutations.trash({ id: row._id })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </td>
              {dbProps.map((prop) => (
                <td key={prop.id}>
                  <Cell
                    row={row}
                    prop={prop}
                    dbProps={dbProps}
                    onAddOption={addOption}
                  />
                </td>
              ))}
              <td className="col-add" />
            </tr>
    );
  }

  /** New row pre-filled with the group's value, Notion-style. */
  async function newRowInGroup(g: RowGroup) {
    const prop = dbProps.find((p) => p.id === groupBy);
    const props: Record<string, unknown> = {};
    if (prop && g.key !== "__none") {
      if (prop.type === "checkbox") props[prop.id] = g.key === "__checked";
      else if (prop.type === "multiSelect") props[prop.id] = [g.key];
      else props[prop.id] = g.key;
    }
    const id = await mutations.create({
      parentId: page._id,
      type: "doc",
      props: Object.keys(props).length ? props : undefined,
    });
    setTitleEdit({ id, value: "" });
  }
}
