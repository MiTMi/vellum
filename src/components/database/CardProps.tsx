import React from "react";
import { DbProp, PageMeta } from "../../lib/types";
import { formatDateLong } from "../../lib/dbviews";

/**
 * Compact property rendering for a database card (board + gallery). Select
 * values become colored chips; everything else becomes a short line.
 * Relations show a link count — resolving titles needs the page index, which
 * the card views don't carry; the table cell and row panel show the names.
 */
export default function CardProps({
  row,
  props,
}: {
  row: PageMeta;
  props: DbProp[];
}) {
  const chips: React.ReactNode[] = [];
  const lines: React.ReactNode[] = [];
  for (const p of props) {
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
