import React, { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { DbProp, PageDoc, PageMeta } from "../../lib/types";
import { useMutations } from "../../data";
import { useNav } from "../../state";
import { toDateKey } from "../../lib/dbviews";

interface CalendarViewProps {
  page: PageDoc;
  rows: PageMeta[];
  locked?: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CalendarView({ page, rows, locked }: CalendarViewProps) {
  const mutations = useMutations();
  const { navigate } = useNav();
  const dbProps = page.dbProps ?? [];

  const dateProp: DbProp | undefined =
    dbProps.find((p) => p.id === page.calendarBy && p.type === "date") ??
    dbProps.find((p) => p.type === "date");

  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const byDay = useMemo(() => {
    const map = new Map<string, PageMeta[]>();
    if (!dateProp) return map;
    for (const row of rows) {
      const v = row.props?.[dateProp.id];
      if (typeof v !== "string" || !v) continue;
      const list = map.get(v);
      if (list) list.push(row);
      else map.set(v, [row]);
    }
    return map;
  }, [rows, dateProp]);

  if (!dateProp) {
    return (
      <div className="board-empty">
        Add a <b>Date</b> property to use the calendar view.
      </div>
    );
  }

  const first = new Date(cursor.year, cursor.month, 1);
  const startOffset = first.getDay(); // Sunday = 0
  const gridStart = new Date(cursor.year, cursor.month, 1 - startOffset);
  const todayKey = toDateKey(new Date());
  const monthLabel = first.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(
        new Date(
          gridStart.getFullYear(),
          gridStart.getMonth(),
          gridStart.getDate() + w * 7 + d,
        ),
      );
    }
    weeks.push(week);
  }
  // Drop a trailing week entirely outside the month.
  const visibleWeeks = weeks.filter((week) =>
    week.some((d) => d.getMonth() === cursor.month),
  );

  const shiftMonth = (delta: number) => {
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const createOn = async (day: Date) => {
    const id = await mutations.create({
      parentId: page._id,
      type: "doc",
      props: { [dateProp.id]: toDateKey(day) },
    });
    navigate(id);
  };

  return (
    <div className="calendar-view">
      <div className="cal-header">
        <span className="cal-month">{monthLabel}</span>
        <div className="cal-nav">
          <button className="icon-btn" onClick={() => shiftMonth(-1)} title="Previous month">
            <ChevronLeft size={16} />
          </button>
          <button
            className="btn subtle"
            onClick={() => {
              const now = new Date();
              setCursor({ year: now.getFullYear(), month: now.getMonth() });
            }}
          >
            Today
          </button>
          <button className="icon-btn" onClick={() => shiftMonth(1)} title="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="cal-grid">
        {WEEKDAYS.map((d) => (
          <div key={d} className="cal-weekday">
            {d}
          </div>
        ))}
        {visibleWeeks.flat().map((day) => {
          const key = toDateKey(day);
          const inMonth = day.getMonth() === cursor.month;
          const cards = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={`cal-cell ${inMonth ? "" : "outside"} ${key === todayKey ? "today" : ""}`}
            >
              <div className="cal-cell-head">
                <span className="cal-daynum">{day.getDate()}</span>
                {!locked && (
                  <button
                    className="cal-add"
                    title="New page on this day"
                    onClick={() => void createOn(day)}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              <div className="cal-cards">
                {cards.slice(0, 4).map((row) => (
                  <button
                    key={row._id}
                    className="cal-card"
                    onClick={() => navigate(row._id)}
                    title={row.title || "Untitled"}
                  >
                    <span className="row-icon">{row.icon ?? "📄"}</span>
                    <span className="cal-card-title">{row.title || "Untitled"}</span>
                  </button>
                ))}
                {cards.length > 4 && (
                  <span className="cal-more">+{cards.length - 4} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
