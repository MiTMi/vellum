import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  DbProp,
  FilterCondition,
  FilterGroup,
  FilterOp,
} from "../../lib/types";
import {
  FILTER_OP_LABELS,
  isFilterGroup,
  operatorsFor,
  opNeedsValue,
} from "../../lib/dbviews";
import Popover from "../ui/Popover";
import { PROP_TYPE_META } from "./PropertyMenu";

/**
 * Compound filter editor for a saved view: a flat list of rules plus at
 * most one level of nested groups, joined by a single And/Or per group —
 * the same cap the schema validator enforces.
 */

interface FilterBuilderProps {
  anchor: HTMLElement;
  onClose: () => void;
  dbProps: DbProp[];
  filter: FilterGroup | undefined;
  setFilter: (f: FilterGroup | undefined) => void;
}

/** The title column plus every property, as filter targets. */
function targets(dbProps: DbProp[]): { id: string; name: string; prop: DbProp | "__title" }[] {
  return [
    { id: "__title", name: "Name", prop: "__title" as const },
    ...dbProps.map((p) => ({ id: p.id, name: p.name, prop: p })),
  ];
}

function defaultOpFor(prop: DbProp | "__title"): FilterOp {
  return operatorsFor(prop)[0];
}

function newCondition(dbProps: DbProp[], propId: string): FilterCondition {
  const t = targets(dbProps).find((t) => t.id === propId);
  return { propId, op: t ? defaultOpFor(t.prop) : "contains" };
}

export default function FilterBuilder({
  anchor,
  onClose,
  dbProps,
  filter,
  setFilter,
}: FilterBuilderProps) {
  const group: FilterGroup = filter ?? { logic: "and", conditions: [] };

  const commit = (next: FilterGroup) => {
    setFilter(next.conditions.length ? next : undefined);
  };

  const setNode = (i: number, node: FilterCondition | FilterGroup) =>
    commit({
      ...group,
      conditions: group.conditions.map((n, j) => (j === i ? node : n)),
    });
  const removeNode = (i: number) =>
    commit({
      ...group,
      conditions: group.conditions.filter((_, j) => j !== i),
    });

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      width={420}
      align="right"
      className="menu filter-builder"
    >
      {group.conditions.length === 0 ? (
        <QuickPick
          dbProps={dbProps}
          onPick={(propId) =>
            commit({ ...group, conditions: [newCondition(dbProps, propId)] })
          }
        />
      ) : (
        <>
          {group.conditions.map((node, i) => (
            <div key={i} className="filter-entry">
              <span className="filter-join">
                {i === 0 ? (
                  "Where"
                ) : i === 1 ? (
                  <select
                    value={group.logic}
                    onChange={(e) =>
                      commit({
                        ...group,
                        logic: e.target.value as "and" | "or",
                      })
                    }
                  >
                    <option value="and">And</option>
                    <option value="or">Or</option>
                  </select>
                ) : group.logic === "and" ? (
                  "And"
                ) : (
                  "Or"
                )}
              </span>
              {isFilterGroup(node) ? (
                <SubGroup
                  group={node}
                  dbProps={dbProps}
                  setGroup={(g) => setNode(i, g)}
                  remove={() => removeNode(i)}
                />
              ) : (
                <RuleRow
                  cond={node}
                  dbProps={dbProps}
                  setCond={(c) => setNode(i, c)}
                  remove={() => removeNode(i)}
                />
              )}
            </div>
          ))}
          <div className="filter-actions">
            <button
              className="btn subtle"
              onClick={() =>
                commit({
                  ...group,
                  conditions: [
                    ...group.conditions,
                    newCondition(dbProps, "__title"),
                  ],
                })
              }
            >
              <Plus size={13} /> Add filter
            </button>
            <button
              className="btn subtle"
              onClick={() =>
                commit({
                  ...group,
                  conditions: [
                    ...group.conditions,
                    {
                      logic: "or",
                      conditions: [newCondition(dbProps, "__title")],
                    },
                  ],
                })
              }
            >
              <Plus size={13} /> Add group
            </button>
            <button
              className="btn subtle filter-clear"
              onClick={() => {
                setFilter(undefined);
                onClose();
              }}
            >
              <X size={13} /> Clear all
            </button>
          </div>
        </>
      )}
    </Popover>
  );
}

/** First-open shortcut: pick a property, get a rule. */
function QuickPick({
  dbProps,
  onPick,
}: {
  dbProps: DbProp[];
  onPick: (propId: string) => void;
}) {
  return (
    <>
      <div className="prop-menu-label">Filter by</div>
      {targets(dbProps).map((t) => (
        <button key={t.id} className="menu-item" onClick={() => onPick(t.id)}>
          {t.prop !== "__title" && (
            <span className="menu-icon">{PROP_TYPE_META[t.prop.type].icon}</span>
          )}
          <span>{t.name}</span>
        </button>
      ))}
    </>
  );
}

/** A nested group: its own logic + flat rules (no deeper nesting). */
function SubGroup({
  group,
  dbProps,
  setGroup,
  remove,
}: {
  group: FilterGroup;
  dbProps: DbProp[];
  setGroup: (g: FilterGroup) => void;
  remove: () => void;
}) {
  // The validator only allows plain conditions inside a nested group.
  const conds = group.conditions.filter(
    (n): n is FilterCondition => !isFilterGroup(n),
  );
  return (
    <div className="filter-subgroup">
      {conds.map((cond, i) => (
        <div key={i} className="filter-entry">
          <span className="filter-join">
            {i === 0 ? (
              "Where"
            ) : i === 1 ? (
              <select
                value={group.logic}
                onChange={(e) =>
                  setGroup({ ...group, logic: e.target.value as "and" | "or" })
                }
              >
                <option value="and">And</option>
                <option value="or">Or</option>
              </select>
            ) : group.logic === "and" ? (
              "And"
            ) : (
              "Or"
            )}
          </span>
          <RuleRow
            cond={cond}
            dbProps={dbProps}
            setCond={(c) =>
              setGroup({
                ...group,
                conditions: conds.map((n, j) => (j === i ? c : n)),
              })
            }
            remove={() => {
              const next = conds.filter((_, j) => j !== i);
              if (!next.length) remove();
              else setGroup({ ...group, conditions: next });
            }}
          />
        </div>
      ))}
      <div className="filter-actions">
        <button
          className="btn subtle"
          onClick={() =>
            setGroup({
              ...group,
              conditions: [...conds, newCondition(dbProps, "__title")],
            })
          }
        >
          <Plus size={13} /> Add filter
        </button>
        <button className="btn subtle filter-clear" onClick={remove}>
          <Trash2 size={13} /> Delete group
        </button>
      </div>
    </div>
  );
}

/** One rule: property · operator · operand. */
function RuleRow({
  cond,
  dbProps,
  setCond,
  remove,
}: {
  cond: FilterCondition;
  dbProps: DbProp[];
  setCond: (c: FilterCondition) => void;
  remove: () => void;
}) {
  const target = targets(dbProps).find((t) => t.id === cond.propId);
  const ops = target ? operatorsFor(target.prop) : [];

  const changeProp = (propId: string) => setCond(newCondition(dbProps, propId));
  const changeOp = (op: FilterOp) => {
    // Operand shapes differ per op family; keep it only when still valid.
    const keep = opNeedsValue(op) && opNeedsValue(cond.op);
    setCond({ propId: cond.propId, op, value: keep ? cond.value : undefined });
  };

  return (
    <div className="filter-rule">
      <select
        className="filter-prop"
        value={cond.propId}
        onChange={(e) => changeProp(e.target.value)}
      >
        {targets(dbProps).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select
        className="filter-op"
        value={cond.op}
        onChange={(e) => changeOp(e.target.value as FilterOp)}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {FILTER_OP_LABELS[op]}
          </option>
        ))}
      </select>
      <ValueEditor
        key={`${cond.propId}:${cond.op}`}
        cond={cond}
        target={target?.prop}
        setCond={setCond}
      />
      <button className="icon-btn small" title="Remove filter" onClick={remove}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function ValueEditor({
  cond,
  target,
  setCond,
}: {
  cond: FilterCondition;
  target: DbProp | "__title" | undefined;
  setCond: (c: FilterCondition) => void;
}) {
  const [text, setText] = useState(
    typeof cond.value === "string" || typeof cond.value === "number"
      ? String(cond.value)
      : "",
  );
  if (!target || !opNeedsValue(cond.op)) return null;

  // Option pickers for select/multiSelect: toggleable chips.
  if (
    target !== "__title" &&
    (target.type === "select" || target.type === "multiSelect") &&
    (cond.op === "anyOf" || cond.op === "noneOf")
  ) {
    const picked = Array.isArray(cond.value) ? cond.value : [];
    return (
      <span className="filter-options">
        {(target.options ?? []).map((o) => (
          <button
            key={o.id}
            className={`chip chip-${o.color} filter-option ${picked.includes(o.id) ? "on" : ""}`}
            onClick={() =>
              setCond({
                ...cond,
                value: picked.includes(o.id)
                  ? picked.filter((id) => id !== o.id)
                  : [...picked, o.id],
              })
            }
          >
            {o.name}
          </button>
        ))}
      </span>
    );
  }

  const isNumber = target !== "__title" && target.type === "number";
  const isDate = cond.op.startsWith("date");

  // Text/number operands commit on blur or Enter, not per keystroke — every
  // commit is a synced setViews mutation. Dates commit on change (one pick).
  const commit = (raw: string) => {
    if (raw === "") setCond({ ...cond, value: undefined });
    else if (isNumber) {
      const n = Number(raw);
      if (!Number.isNaN(n)) setCond({ ...cond, value: n });
    } else setCond({ ...cond, value: raw });
  };

  return (
    <input
      className="filter-value"
      type={isDate ? "date" : isNumber ? "number" : "text"}
      value={text}
      placeholder="Value"
      onChange={(e) => {
        setText(e.target.value);
        if (isDate) commit(e.target.value);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
      }}
    />
  );
}
