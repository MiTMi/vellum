import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Search, Sparkles } from "lucide-react";
import { DbProp, PageId, PageMeta, SelectOption, childrenKey } from "../../lib/types";
import { useAi, useMutations } from "../../data";
import { usePagesIndex } from "../../hooks/usePagesIndex";
import {
  computeFormula,
  computeRollup,
  formatDateValue,
  formatTimestamp,
  makeDateValue,
  parseDateValue,
} from "../../lib/dbviews";
import { formatFormulaValue } from "../../lib/formula";
import { useNav } from "../../state";
import SelectPopover from "./SelectPopover";
import Popover from "../ui/Popover";

/**
 * The shape Cell needs from a row. Structural rather than `PageMeta` so the
 * row-page property panel can pass a full `PageDoc` — computed property
 * types (createdTime / lastEditedTime / rollup) read the row's own
 * timestamps, not `props`, so the whole row has to come through.
 */
export interface CellRow {
  _id: PageId;
  _creationTime: number;
  updatedAt: number;
  props?: Record<string, unknown> | null;
  /** Share role when the row reaches me through a share (Phase 2). */
  role?: "viewer" | "editor";
}

interface CellProps {
  row: CellRow;
  prop: DbProp;
  /** Sibling properties — rollups resolve their relation column through these. */
  dbProps: DbProp[];
  /** persist new options created inline */
  onAddOption: (propId: string, option: SelectOption) => void;
  bare?: boolean; // borderless style for row-page property panel
}

export default function Cell({
  row,
  prop,
  dbProps,
  onAddOption,
  bare,
}: CellProps) {
  const rowId = row._id;
  const value = row.props?.[prop.id];
  const mutations = useMutations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Viewer-role shared rows are read-only: no popovers, no edits, and
  // `set` is inert as a backstop so no path can queue a doomed write.
  const readOnly = row.role === "viewer";
  const set = (v: unknown) => {
    if (readOnly) return;
    void mutations.setRowProp({ id: rowId, propId: prop.id, value: v });
  };

  const startEdit = () => {
    setDraft(
      typeof value === "string" || typeof value === "number" ? String(value) : "",
    );
    setEditing(true);
  };

  const commitText = () => {
    setEditing(false);
    const t = draft.trim();
    if (prop.type === "number") {
      if (t === "") return set(null);
      const n = Number(t);
      if (!Number.isNaN(n)) set(n);
    } else {
      set(t === "" ? null : t);
    }
  };

  const cls = `cell cell-${prop.type} ${bare ? "bare" : ""}`;

  switch (prop.type) {
    // Computed, read-only: value comes from the row itself or from related
    // rows, never from `props`, so there is nothing to edit or persist.
    case "createdTime":
      return (
        <div className={`${cls} computed`}>
          <span className="cell-value">{formatTimestamp(row._creationTime)}</span>
        </div>
      );

    case "lastEditedTime":
      return (
        <div className={`${cls} computed`}>
          <span className="cell-value">{formatTimestamp(row.updatedAt)}</span>
        </div>
      );

    case "rollup":
      return <RollupCell row={row} prop={prop} dbProps={dbProps} cls={cls} />;

    case "formula":
      return <FormulaCell row={row} prop={prop} dbProps={dbProps} cls={cls} />;

    case "ai":
      return <AiCell row={row} prop={prop} cls={cls} onSet={set} />;

    case "checkbox":
      return (
        <div className={cls}>
          <input
            type="checkbox"
            checked={value === true}
            disabled={readOnly}
            onChange={(e) => set(e.target.checked)}
          />
        </div>
      );

    case "select":
    case "multiSelect": {
      const ids = Array.isArray(value)
        ? (value as string[])
        : typeof value === "string" && value
          ? [value]
          : [];
      const options = prop.options ?? [];
      const chips = ids
        .map((id) => options.find((o) => o.id === id))
        .filter(Boolean) as SelectOption[];
      return (
        <>
          <div className={cls} onClick={readOnly ? undefined : (e) => setAnchor(e.currentTarget)}>
            {chips.length ? (
              chips.map((o) => (
                <span key={o.id} className={`chip chip-${o.color}`}>
                  {o.name}
                </span>
              ))
            ) : (
              <span className="cell-placeholder">—</span>
            )}
          </div>
          {anchor && (
            <SelectPopover
              anchor={anchor}
              onClose={() => setAnchor(null)}
              prop={prop}
              value={ids}
              multi={prop.type === "multiSelect"}
              onToggle={(optionId, selected) => {
                if (prop.type === "select") {
                  set(selected ? optionId : null);
                } else {
                  const next = selected
                    ? [...ids, optionId]
                    : ids.filter((i) => i !== optionId);
                  set(next.length ? next : null);
                }
              }}
              onCreateOption={(option) => onAddOption(prop.id, option)}
            />
          )}
        </>
      );
    }

    case "relation": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return (
        <>
          <div className={cls} onClick={readOnly ? undefined : (e) => setAnchor(e.currentTarget)}>
            <RelationChips ids={ids} />
          </div>
          {anchor && (
            <RelationPopover
              anchor={anchor}
              onClose={() => setAnchor(null)}
              prop={prop}
              selected={ids}
              onToggle={(id, on) => {
                const next = on ? [...ids, id] : ids.filter((i) => i !== id);
                set(next.length ? next : null);
              }}
            />
          )}
        </>
      );
    }

    case "date":
      return (
        <>
          <div className={cls} onClick={readOnly ? undefined : (e) => setAnchor(e.currentTarget)}>
            {parseDateValue(value) ? (
              formatDateValue(value)
            ) : (
              <span className="cell-placeholder">—</span>
            )}
          </div>
          {anchor && (
            <DateEditor
              anchor={anchor}
              value={value}
              onClose={() => setAnchor(null)}
              onChange={(v) => set(v)}
            />
          )}
        </>
      );

    case "url":
      if (editing) {
        return (
          <div className={cls}>
            <input
              ref={inputRef}
              className="cell-input"
              value={draft}
              placeholder="https://…"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          </div>
        );
      }
      return (
        <div className={cls} onClick={readOnly ? undefined : startEdit}>
          {typeof value === "string" && value ? (
            <span className="url-value">
              <span className="url-text">{value.replace(/^https?:\/\//, "")}</span>
              <a
                href={value.startsWith("http") ? value : `https://${value}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="url-open"
                title="Open link"
              >
                <ExternalLink size={13} />
              </a>
            </span>
          ) : (
            <span className="cell-placeholder">—</span>
          )}
        </div>
      );

    default:
      // text & number
      if (editing) {
        return (
          <div className={cls}>
            <input
              ref={inputRef}
              className="cell-input"
              value={draft}
              inputMode={prop.type === "number" ? "decimal" : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          </div>
        );
      }
      return (
        <div className={cls} onClick={readOnly ? undefined : startEdit}>
          {value !== undefined && value !== null && value !== "" ? (
            <span className="cell-value">{String(value)}</span>
          ) : (
            <span className="cell-placeholder">—</span>
          )}
        </div>
      );
  }
}

/**
 * Notion's AI property: a column whose value the model writes from the row's
 * own page content.
 *
 * Unlike rollup/formula this value *is* stored. Generation costs a network
 * round-trip and money, so it must never re-run on render — the user asks for
 * it explicitly, and the result persists through the normal `setRowProp`
 * mutation (which means it syncs through the offline outbox like any edit).
 */
function AiCell({
  row,
  prop,
  cls,
  onSet,
}: {
  row: CellRow;
  prop: DbProp;
  cls: string;
  onSet: (v: unknown) => void;
}) {
  const ai = useAi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = row.props?.[prop.id];
  const text = typeof value === "string" ? value : "";
  const readOnly = row.role === "viewer";

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await ai.fillProperty({
        pageId: row._id,
        kind: prop.aiKind ?? "summary",
        prompt: prop.aiPrompt,
      });
      onSet(result);
    } catch (err) {
      const data = (err as { data?: unknown }).data;
      setError(
        typeof data === "string"
          ? data
          : err instanceof Error
            ? err.message
            : "Generation failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cls} title={error ?? undefined}>
      <div className="ai-cell">
        {text && <span className="ai-cell-value">{text}</span>}
        {ai.available && !readOnly && (
          <button
            className="ai-cell-generate"
            disabled={busy}
            onClick={() => void generate()}
            // The button sits inside a row that navigates on click.
            onMouseDown={(e) => e.stopPropagation()}
          >
            {busy ? (
              <Loader2 size={12} className="ai-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            {busy ? "Generating…" : text ? "Regenerate" : "Generate"}
          </button>
        )}
        {error && !busy && (
          <span className="cell-formula-error" title={error}>
            Failed
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A rollup aggregates *other* rows, so it needs the page index. Split into
 * its own component to keep the hook out of Cell's switch.
 */
/** Read-only, like the other computed types: the value is never stored. */
function FormulaCell({
  row,
  prop,
  dbProps,
  cls,
}: {
  row: CellRow;
  prop: DbProp;
  dbProps: DbProp[];
  cls: string;
}) {
  const index = usePagesIndex();
  const meta = index.byId.get(row._id);
  if (!meta) {
    // Mid-remap (offline row whose create hasn't replayed): show empty
    // rather than throw, matching RollupCell.
    return <div className={`${cls} computed`} />;
  }
  const { value, error } = computeFormula(meta, prop, dbProps, index.byId);
  if (error) {
    return (
      <div className={`${cls} computed`} title={error}>
        <span className="cell-formula-error">Error</span>
      </div>
    );
  }
  const display = formatFormulaValue(value);
  return (
    <div
      className={`${cls} computed`}
      title={prop.formula ? undefined : "Add an expression in the property menu"}
    >
      <span className={display === "" ? "cell-placeholder" : "cell-value"}>
        {display === "" ? "—" : display}
      </span>
    </div>
  );
}

function RollupCell({
  row,
  prop,
  dbProps,
  cls,
}: {
  row: CellRow;
  prop: DbProp;
  dbProps: DbProp[];
  cls: string;
}) {
  const index = usePagesIndex();
  const meta = index.byId.get(row._id);
  // A rollup reads the row through the index (it needs PageMeta's shape);
  // a row missing from it — e.g. mid-remap — shows as empty rather than
  // throwing.
  const result = meta
    ? computeRollup(meta, prop, dbProps, index.byId)
    : { display: "—", sortVal: 0 };
  const configured = prop.relationPropId && prop.rollupPropId;
  return (
    <div className={`${cls} computed`} title={configured ? undefined : "Configure this rollup in the property menu"}>
      <span className={result.display === "—" ? "cell-placeholder" : "cell-value"}>
        {configured ? result.display : "—"}
      </span>
    </div>
  );
}

/**
 * Linked rows as clickable chips. Ids missing from the index (target row
 * deleted, or a replayed op racing a delete) are simply dropped — a relation
 * degrades to fewer chips rather than to a broken one.
 */
function RelationChips({ ids }: { ids: string[] }) {
  const index = usePagesIndex();
  const { navigate } = useNav();
  const linked = ids
    .map((id) => index.byId.get(id))
    .filter((p): p is PageMeta => Boolean(p));

  if (!linked.length) return <span className="cell-placeholder">—</span>;
  return (
    <>
      {linked.map((p) => (
        <span
          key={p._id}
          className="relation-chip"
          onClick={(e) => {
            e.stopPropagation();
            navigate(p._id);
          }}
        >
          <span className="relation-chip-icon">{p.icon ?? "📄"}</span>
          {p.title || "Untitled"}
        </span>
      ))}
    </>
  );
}

function RelationPopover({
  anchor,
  onClose,
  prop,
  selected,
  onToggle,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  prop: DbProp;
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  const index = usePagesIndex();
  const [term, setTerm] = useState("");

  const candidates = useMemo(() => {
    if (!prop.targetId) return [];
    const rows = index.children.get(childrenKey(prop.targetId as PageId)) ?? [];
    const t = term.trim().toLowerCase();
    return (t ? rows.filter((r) => r.title.toLowerCase().includes(t)) : rows).slice(
      0,
      50,
    );
  }, [index, prop.targetId, term]);

  return (
    <Popover anchor={anchor} onClose={onClose} width={260} className="menu">
      {!prop.targetId ? (
        <div className="select-empty">
          Pick a related database in this property&rsquo;s menu first.
        </div>
      ) : (
        <>
          <div className="qs-input-row small">
            <Search size={14} />
            <input
              autoFocus
              placeholder="Link a row…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </div>
          {candidates.map((row) => {
            const on = selected.includes(row._id);
            return (
              <button
                key={row._id}
                className="menu-item"
                onClick={() => onToggle(row._id, !on)}
              >
                <input type="checkbox" readOnly checked={on} />
                <span className="relation-chip-icon">{row.icon ?? "📄"}</span>
                <span className="move-title">{row.title || "Untitled"}</span>
              </button>
            );
          })}
          {candidates.length === 0 && (
            <div className="select-empty">No rows to link.</div>
          )}
        </>
      )}
    </Popover>
  );
}

/**
 * Start date, plus an optional end date behind a toggle — Notion's date
 * range. Clearing the start clears the whole value, since a range with no
 * start is meaningless.
 */
function DateEditor({
  anchor,
  value,
  onClose,
  onChange,
}: {
  anchor: HTMLElement;
  value: unknown;
  onClose: () => void;
  onChange: (v: string | { start: string; end?: string } | null) => void;
}) {
  const parsed = parseDateValue(value);
  const [start, setStart] = useState(parsed?.start ?? "");
  const [end, setEnd] = useState(parsed?.end ?? "");
  const [ranged, setRanged] = useState(Boolean(parsed?.end));

  const commit = (nextStart: string, nextEnd: string, useRange: boolean) => {
    if (!nextStart) {
      onChange(null);
      return;
    }
    onChange(makeDateValue(nextStart, useRange ? nextEnd : undefined));
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={230} className="date-popover">
      <input
        type="date"
        className="date-input"
        autoFocus
        value={start}
        onChange={(e) => {
          setStart(e.target.value);
          commit(e.target.value, end, ranged);
        }}
      />
      {ranged && (
        <input
          type="date"
          className="date-input"
          value={end}
          // An end before the start is not a range; the input enforces it.
          min={start || undefined}
          onChange={(e) => {
            setEnd(e.target.value);
            commit(start, e.target.value, true);
          }}
        />
      )}
      <label className="date-range-toggle">
        <input
          type="checkbox"
          checked={ranged}
          onChange={(e) => {
            setRanged(e.target.checked);
            commit(start, end, e.target.checked);
          }}
        />
        End date
      </label>
      <button
        className="btn subtle"
        onClick={() => {
          onChange(null);
          onClose();
        }}
      >
        Clear
      </button>
    </Popover>
  );
}
