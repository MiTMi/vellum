import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { DbProp, PageDoc, PageId, PageMeta } from "../../lib/types";
import { requestPeek, useNav } from "../../state";
import { parseDateValue, toDateKey } from "../../lib/dbviews";

/**
 * Notion's timeline: one horizontal bar per row, positioned by its date
 * property. A row with a plain date gets a single-day bar; a row with a
 * range spans start → end (see `parseDateValue` — both shapes are stored).
 *
 * Which property drives it is `page.calendarBy`, shared with the calendar
 * view: both answer "which date column is this database about", and sharing
 * it means picking one in either view carries over to the other.
 */

interface TimelineViewProps {
  page: PageDoc;
  rows: PageMeta[];
  locked?: boolean;
}

const DAY_MS = 86_400_000;
const DAY_WIDTH = 34;
/** Empty padding either side so bars never start flush against the edge. */
const PAD_DAYS = 3;

const parseDay = (key: string) => new Date(`${key}T00:00:00`);
const daysBetween = (a: Date, b: Date) =>
  Math.round((b.getTime() - a.getTime()) / DAY_MS);

const MONTH_FMT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

export default function TimelineView({ page, rows, locked }: TimelineViewProps) {
  const { navigate } = useNav();
  const dbProps = page.dbProps ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  const dateProp: DbProp | undefined =
    dbProps.find((p) => p.id === page.calendarBy && p.type === "date") ??
    dbProps.find((p) => p.type === "date");

  const { bars, undated } = useMemo(() => {
    const bars: { row: PageMeta; start: string; end: string }[] = [];
    const undated: PageMeta[] = [];
    if (!dateProp) return { bars, undated };
    for (const row of rows) {
      const v = parseDateValue(row.props?.[dateProp.id]);
      if (!v) {
        undated.push(row);
        continue;
      }
      bars.push({ row, start: v.start, end: v.end ?? v.start });
    }
    bars.sort((a, b) => a.start.localeCompare(b.start));
    return { bars, undated };
  }, [rows, dateProp]);

  // The window the chart covers: the rows' own span, padded, and always wide
  // enough to include today so the "today" marker has somewhere to live.
  const { first, totalDays } = useMemo(() => {
    const today = toDateKey(new Date());
    const starts = bars.map((b) => b.start).concat(today);
    const ends = bars.map((b) => b.end).concat(today);
    const min = parseDay(starts.reduce((a, b) => (a < b ? a : b)));
    const max = parseDay(ends.reduce((a, b) => (a > b ? a : b)));
    const first = new Date(min);
    first.setDate(first.getDate() - PAD_DAYS);
    return { first, totalDays: daysBetween(first, max) + PAD_DAYS * 2 + 1 };
  }, [bars]);

  const days = useMemo(
    () =>
      Array.from({ length: totalDays }, (_, i) => {
        const d = new Date(first);
        d.setDate(d.getDate() + i);
        return d;
      }),
    [first, totalDays],
  );

  // Month header cells: one per run of days sharing a month.
  const months = useMemo(() => {
    const out: { label: string; days: number }[] = [];
    for (const d of days) {
      const label = MONTH_FMT.format(d);
      const last = out[out.length - 1];
      if (last && last.label === label) last.days++;
      else out.push({ label, days: 1 });
    }
    return out;
  }, [days]);

  const todayOffset = daysBetween(first, parseDay(toDateKey(new Date())));

  // Open on today rather than at the far left of a long project history.
  const [scrolled, setScrolled] = useState(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolled || !days.length) return;
    el.scrollLeft = Math.max(0, todayOffset * DAY_WIDTH - el.clientWidth / 3);
    setScrolled(true);
  }, [todayOffset, days.length, scrolled]);

  const open = (id: PageId, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) navigate(id);
    else requestPeek(id);
  };

  if (!dateProp) {
    return (
      <div className="board-empty">
        Add a <b>Date</b> property to use the timeline view.
      </div>
    );
  }

  const width = totalDays * DAY_WIDTH;

  return (
    <div className="timeline-view">
      <div className="timeline-scroll" ref={scrollRef}>
        <div className="timeline-inner" style={{ width }}>
          <div className="timeline-months">
            {months.map((m, i) => (
              <div
                key={`${m.label}-${i}`}
                className="timeline-month"
                style={{ width: m.days * DAY_WIDTH }}
              >
                <span>{m.label}</span>
              </div>
            ))}
          </div>
          <div className="timeline-days">
            {days.map((d) => {
              const weekend = d.getDay() === 0 || d.getDay() === 6;
              return (
                <div
                  key={d.toISOString()}
                  className={`timeline-day${weekend ? " weekend" : ""}`}
                  style={{ width: DAY_WIDTH }}
                >
                  {d.getDate()}
                </div>
              );
            })}
          </div>

          <div className="timeline-body">
            {/* Weekend shading and the today line sit behind the bars. */}
            <div className="timeline-grid" aria-hidden="true">
              {days.map((d, i) => (
                <div
                  key={i}
                  className={`timeline-col${
                    d.getDay() === 0 || d.getDay() === 6 ? " weekend" : ""
                  }`}
                  style={{ width: DAY_WIDTH }}
                />
              ))}
            </div>
            <div
              className="timeline-today"
              style={{ left: todayOffset * DAY_WIDTH + DAY_WIDTH / 2 }}
              aria-hidden="true"
            />

            {bars.map(({ row, start, end }) => {
              const offset = daysBetween(first, parseDay(start));
              const span = daysBetween(parseDay(start), parseDay(end)) + 1;
              return (
                <div className="timeline-lane" key={row._id}>
                  <button
                    className="timeline-bar"
                    style={{
                      left: offset * DAY_WIDTH + 2,
                      width: Math.max(span * DAY_WIDTH - 4, 22),
                    }}
                    title={row.title || "Untitled"}
                    onClick={(e) => open(row._id, e)}
                    disabled={locked}
                  >
                    {row.icon && <span className="timeline-bar-icon">{row.icon}</span>}
                    <span className="timeline-bar-title">
                      {row.title || "Untitled"}
                    </span>
                  </button>
                </div>
              );
            })}
            {bars.length === 0 && (
              <div className="timeline-empty">
                No rows have a {dateProp.name} yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {undated.length > 0 && (
        <div className="timeline-undated">
          <div className="timeline-undated-label">
            Not scheduled · {undated.length}
          </div>
          <div className="timeline-undated-rows">
            {undated.map((row) => (
              <button
                key={row._id}
                className="timeline-chip"
                onClick={(e) => open(row._id, e)}
              >
                {row.icon && <span>{row.icon}</span>}
                {row.title || "Untitled"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
