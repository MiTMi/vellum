import React from "react";
import { DbProp, PageMeta } from "../../lib/types";
import {
  computeRollup,
  formatDateLong,
  formatTimestamp,
  RowIndex,
} from "../../lib/dbviews";

/**
 * Compact property rendering for a database card (board + gallery). Select
 * values become colored chips; everything else becomes a short line.
 * Relations show a link count — resolving titles needs the page index, which
 * the card views don't carry; the table cell and row panel show the names.
 */
export default function CardProps({
  row,
  props,
  dbProps,
  byId,
}: {
  row: PageMeta;
  props: DbProp[];
  /** All sibling properties — rollups follow their relation column. */
  dbProps?: DbProp[];
  byId?: RowIndex;
}) {
  const chips: React.ReactNode[] = [];
  const lines: React.ReactNode[] = [];
  for (const p of props) {
    // Computed types have no stored value, so they're handled before the
    // "skip empty" guard below.
    if (p.type === "createdTime" || p.type === "lastEditedTime") {
      lines.push(
        <div key={p.id} className="board-date">
          {formatTimestamp(
            p.type === "createdTime" ? row._creationTime : row.updatedAt,
          )}
        </div>,
      );
      continue;
    }
    if (p.type === "rollup") {
      const { display } = computeRollup(row, p, dbProps ?? props, byId);
      if (display !== "—") {
        lines.push(
          <div key={p.id} className="board-plain">
            {display}
          </div>,
        );
      }
      continue;
    }
    const v = row.props?.[p.id];
    if (v === undefined || v === null || v === "") continue;
    if (p.type === "select" && typeof v === "string") {
      const o = p.options?.find((x) => x.id === v);
      if (o)
        chips.push(
          <span key={p.id} className={`chip chip-${o.color}`}>
            {o.name}
          </span>,
        );
    } else if (p.type === "multiSelect" && Array.isArray(v)) {
      for (const id of (v as string[]).slice(0, 3)) {
        const o = p.options?.find((x) => x.id === id);
        if (o)
          chips.push(
            <span key={p.id + id} className={`chip chip-${o.color}`}>
              {o.name}
            </span>,
          );
      }
    } else if (p.type === "relation") {
      const ids = Array.isArray(v) ? (v as string[]) : [];
      if (ids.length)
        chips.push(
          <span key={p.id} className="chip chip-blue">
            {ids.length} linked
          </span>,
        );
    } else if (p.type === "date" && typeof v === "string") {
      lines.push(
        <div key={p.id} className="board-date">
          {formatDateLong(v)}
        </div>,
      );
    } else {
      lines.push(
        <div key={p.id} className="board-plain">
          {String(v)}
        </div>,
      );
    }
  }
  if (!chips.length && !lines.length) return null;
  return (
    <>
      {chips.length > 0 && <div className="board-card-props">{chips}</div>}
      {lines}
    </>
  );
}
