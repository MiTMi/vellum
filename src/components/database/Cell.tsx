import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { DbProp, PageId, PageMeta, SelectOption, childrenKey } from "../../lib/types";
import { useMutations } from "../../data";
import { usePagesIndex } from "../../hooks/usePagesIndex";
import { useNav } from "../../state";
import SelectPopover from "./SelectPopover";
import Popover from "../ui/Popover";

interface CellProps {
  rowId: PageId;
  prop: DbProp;
  value: unknown;
  /** persist new options created inline */
  onAddOption: (propId: string, option: SelectOption) => void;
  bare?: boolean; // borderless style for row-page property panel
}

function formatDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function Cell({ rowId, prop, value, onAddOption, bare }: CellProps) {
  const mutations = useMutations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const set = (v: unknown) => void mutations.setRowProp({ id: rowId, propId: prop.id, value: v });

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
    case "checkbox":
      return (
        <div className={cls}>
          <input
            type="checkbox"
            checked={value === true}
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
          <div className={cls} onClick={(e) => setAnchor(e.currentTarget)}>
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
          <div className={cls} onClick={(e) => setAnchor(e.currentTarget)}>
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
          <div className={cls} onClick={(e) => setAnchor(e.currentTarget)}>
            {typeof value === "string" && value ? (
              formatDate(value)
            ) : (
              <span className="cell-placeholder">—</span>
            )}
          </div>
          {anchor && (
            <DateEditor
              anchor={anchor}
              value={typeof value === "string" ? value : ""}
              onClose={() => setAnchor(null)}
              onChange={(v) => set(v || null)}
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
        <div className={cls} onClick={startEdit}>
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
        <div className={cls} onClick={startEdit}>
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

function DateEditor({
  anchor,
  value,
  onClose,
  onChange,
}: {
  anchor: HTMLElement;
  value: string;
  onClose: () => void;
  onChange: (v: string) => void;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={230} className="date-popover">
      <input
        type="date"
        className="date-input"
        autoFocus
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        className="btn subtle"
        onClick={() => {
          onChange("");
          onClose();
        }}
      >
        Clear
      </button>
    </Popover>
  );
}
