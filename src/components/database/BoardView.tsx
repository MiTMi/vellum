import { useMemo, useState } from "react";
import { Plus, ArrowUpRight } from "lucide-react";
import { DbProp, DbView, PageDoc, PageMeta, PageId } from "../../lib/types";
import { useMutations } from "../../data";
import { usePagesIndex } from "../../hooks/usePagesIndex";
import { requestPeek, useNav } from "../../state";
import CardProps from "./CardProps";

interface BoardViewProps {
  page: PageDoc;
  /** The saved view being rendered — grouping config lives on it. */
  view: DbView;
  rows: PageMeta[];
  locked?: boolean;
}

export default function BoardView({ page, view, rows, locked }: BoardViewProps) {
  const mutations = useMutations();
  const index = usePagesIndex();
  const { navigate } = useNav();
  const dbProps = page.dbProps ?? [];
  const [dragRow, setDragRow] = useState<PageId | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  const groupProp: DbProp | undefined =
    dbProps.find((p) => p.id === view.boardGroupBy && p.type === "select") ??
    dbProps.find((p) => p.type === "select");

  const columns = useMemo(() => {
    const options = groupProp?.options ?? [];
    const cols: {
      id: string | null;
      name: string;
      color: string;
      rows: PageMeta[];
    }[] = [
      { id: null, name: `No ${groupProp?.name ?? "status"}`, color: "gray", rows: [] },
      ...options.map((o) => ({
        id: o.id as string | null,
        name: o.name,
        color: o.color,
        rows: [] as PageMeta[],
      })),
    ];
    for (const row of rows) {
      const val = groupProp ? row.props?.[groupProp.id] : null;
      const col = cols.find((c) => c.id === (typeof val === "string" ? val : null));
      (col ?? cols[0]).rows.push(row);
    }
    // "No status" goes last, like Notion's default layout keeps groups tidy.
    return [...cols.slice(1), cols[0]];
  }, [rows, groupProp]);

  if (!groupProp) {
    return (
      <div className="board-empty">
        Add a <b>Select</b> property to group this board.
      </div>
    );
  }

  const otherProps = dbProps
    .filter((p) => p.id !== groupProp.id && p.type !== "checkbox")
    .slice(0, 3);

  return (
    <div className="board-view">
      {columns.map((col) => (
        <div
          key={col.id ?? "__none"}
          data-color={col.color}
          className={`board-col ${overCol === (col.id ?? "__none") ? "drag-over" : ""}`}
          onDragOver={(e) => {
            if (!dragRow) return;
            e.preventDefault();
            setOverCol(col.id ?? "__none");
          }}
          onDragLeave={() => setOverCol(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOverCol(null);
            if (!dragRow) return;
            void mutations.setRowProp({
              id: dragRow,
              propId: groupProp.id,
              value: col.id,
            });
            setDragRow(null);
          }}
        >
          <div className="board-col-head">
            <span className={`chip chip-${col.color}`}>{col.name}</span>
            <span className="board-count">{col.rows.length}</span>
          </div>
          <div className="board-cards">
            {col.rows.map((row) => (
              <div
                key={row._id}
                className="board-card"
                draggable
                onDragStart={(e) => {
                  setDragRow(row._id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragRow(null)}
                onClick={() => requestPeek(row._id)}
              >
                <div className="board-card-title">
                  <span className="row-icon">{row.icon ?? "📄"}</span>
                  <span>{row.title || "Untitled"}</span>
                  <ArrowUpRight size={13} className="board-open" />
                </div>
                <CardProps
                  row={row}
                  props={otherProps}
                  dbProps={dbProps}
                  byId={index.byId}
                />
              </div>
            ))}
          </div>
          {!locked && (
            <button
              className="board-add"
              onClick={async () => {
                const id = await mutations.create({
                  parentId: page._id,
                  type: "doc",
                  props: col.id ? { [groupProp.id]: col.id } : undefined,
                });
                requestPeek(id);
              }}
            >
              <Plus size={14} /> New page
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
