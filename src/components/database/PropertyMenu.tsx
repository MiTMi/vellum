import React, { useState } from "react";
import {
  Type,
  Hash,
  ChevronDown,
  Calendar,
  CheckSquare,
  Link as LinkIcon,
  List,
  Tags,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
  GitBranch,
  Database,
  Clock,
  History,
  Sigma,
  FunctionSquare,
  Sparkles,
} from "lucide-react";
import Popover from "../ui/Popover";
import {
  AiPropKind,
  DbProp,
  PropType,
  RollupCalc,
  SelectOption,
} from "../../lib/types";
import { SELECT_COLORS, randomColor } from "../../lib/colors";
import { uid } from "../../lib/ranks";
import { usePage, usePagesList } from "../../data";
import { checkFormula } from "../../lib/formula";

export const PROP_TYPE_META: Record<
  PropType,
  { label: string; icon: React.ReactNode }
> = {
  text: { label: "Text", icon: <Type size={15} /> },
  number: { label: "Number", icon: <Hash size={15} /> },
  select: { label: "Select", icon: <List size={15} /> },
  multiSelect: { label: "Multi-select", icon: <Tags size={15} /> },
  date: { label: "Date", icon: <Calendar size={15} /> },
  checkbox: { label: "Checkbox", icon: <CheckSquare size={15} /> },
  url: { label: "URL", icon: <LinkIcon size={15} /> },
  relation: { label: "Relation", icon: <GitBranch size={15} /> },
  createdTime: { label: "Created time", icon: <Clock size={15} /> },
  lastEditedTime: { label: "Last edited time", icon: <History size={15} /> },
  rollup: { label: "Rollup", icon: <Sigma size={15} /> },
  formula: { label: "Formula", icon: <FunctionSquare size={15} /> },
  ai: { label: "AI", icon: <Sparkles size={15} /> },
};

/** What an AI column generates for each row (convex/ai.ts `fillProperty`). */
export const AI_PROP_KINDS: { id: AiPropKind; label: string; hint: string }[] = [
  { id: "summary", label: "Summary", hint: "One-sentence summary of the page" },
  { id: "keyTopics", label: "Key topics", hint: "2–4 main topics, comma-separated" },
  { id: "sentiment", label: "Sentiment", hint: "Positive, Neutral, or Negative" },
  { id: "actionItems", label: "Action items", hint: "Concrete next steps, one per line" },
  { id: "custom", label: "Custom…", hint: "Your own instruction" },
];

const ROLLUP_CALCS: { id: RollupCalc; label: string }[] = [
  { id: "count", label: "Count all" },
  { id: "countValues", label: "Count values" },
  { id: "sum", label: "Sum" },
  { id: "average", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
  { id: "percentChecked", label: "Percent checked" },
  { id: "showOriginal", label: "Show original" },
];

interface PropertyMenuProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  prop: DbProp;
  /** All properties of this database — rollups pick a relation from them. */
  dbProps?: DbProp[];
  update: (next: DbProp) => void;
  remove: () => void;
  sort?: (dir: "asc" | "desc" | null) => void;
}

export default function PropertyMenu({
  anchor,
  onClose,
  prop,
  dbProps = [],
  update,
  remove,
  sort,
}: PropertyMenuProps) {
  const [typeOpen, setTypeOpen] = useState(false);
  const [name, setName] = useState(prop.name);
  const isSelect = prop.type === "select" || prop.type === "multiSelect";
  const pages = usePagesList();
  const databases = (pages ?? []).filter((p) => p.type === "database");

  const commitName = () => {
    const n = name.trim();
    if (n && n !== prop.name) update({ ...prop, name: n });
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={280} className="prop-menu">
      <input
        className="prop-name-input"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitName();
            onClose();
          }
        }}
      />

      <div className="prop-menu-label">Type</div>
      <button className="prop-type-btn" onClick={() => setTypeOpen((o) => !o)}>
        {PROP_TYPE_META[prop.type].icon}
        <span>{PROP_TYPE_META[prop.type].label}</span>
        <ChevronDown size={14} style={{ marginLeft: "auto" }} />
      </button>
      {typeOpen && (
        <div className="prop-type-list">
          {(Object.keys(PROP_TYPE_META) as PropType[]).map((t) => (
            <button
              key={t}
              className={`menu-item ${t === prop.type ? "active" : ""}`}
              onClick={() => {
                setTypeOpen(false);
                if (t === prop.type) return;
                const next: DbProp = { ...prop, type: t };
                if ((t === "select" || t === "multiSelect") && !next.options) {
                  next.options = [];
                }
                update(next);
              }}
            >
              <span className="menu-icon">{PROP_TYPE_META[t].icon}</span>
              <span>{PROP_TYPE_META[t].label}</span>
            </button>
          ))}
        </div>
      )}

      {prop.type === "relation" && (
        <>
          <div className="prop-menu-label">Related database</div>
          <div className="prop-options">
            {databases.map((db) => (
              <button
                key={db._id}
                className={`menu-item ${db._id === prop.targetId ? "active" : ""}`}
                onClick={() => update({ ...prop, targetId: db._id })}
              >
                <span className="menu-icon">
                  {db.icon ?? <Database size={15} />}
                </span>
                <span>{db.title || "Untitled database"}</span>
              </button>
            ))}
            {databases.length === 0 && (
              <div className="select-empty">
                Create a database to relate rows to.
              </div>
            )}
          </div>
        </>
      )}

      {prop.type === "rollup" && (
        <RollupConfig prop={prop} dbProps={dbProps} update={update} />
      )}

      {prop.type === "formula" && (
        <FormulaConfig prop={prop} dbProps={dbProps} update={update} />
      )}

      {prop.type === "ai" && <AiConfig prop={prop} update={update} />}

      {isSelect && (
        <>
          <div className="prop-menu-label">Options</div>
          <div className="prop-options">
            {(prop.options ?? []).map((o) => (
              <OptionRow
                key={o.id}
                option={o}
                onChange={(next) =>
                  update({
                    ...prop,
                    options: (prop.options ?? []).map((x) =>
                      x.id === o.id ? next : x,
                    ),
                  })
                }
                onRemove={() =>
                  update({
                    ...prop,
                    options: (prop.options ?? []).filter((x) => x.id !== o.id),
                  })
                }
              />
            ))}
            <AddOption
              onAdd={(nameValue) =>
                update({
                  ...prop,
                  options: [
                    ...(prop.options ?? []),
                    { id: uid(), name: nameValue, color: randomColor() },
                  ],
                })
              }
            />
          </div>
        </>
      )}

      {sort && (
        <>
          <div className="menu-divider" />
          <button className="menu-item" onClick={() => { sort("asc"); onClose(); }}>
            <span className="menu-icon"><ArrowUp size={15} /></span>
            <span>Sort ascending</span>
          </button>
          <button className="menu-item" onClick={() => { sort("desc"); onClose(); }}>
            <span className="menu-icon"><ArrowDown size={15} /></span>
            <span>Sort descending</span>
          </button>
        </>
      )}

      <div className="menu-divider" />
      <button
        className="menu-item danger"
        onClick={() => {
          onClose();
          remove();
        }}
      >
        <span className="menu-icon">
          <Trash2 size={15} />
        </span>
        <span>Delete property</span>
      </button>
    </Popover>
  );
}

/**
 * Rollup configuration: follow one of this database's relation columns, pick
 * a property on the *target* database's rows, pick an aggregation.
 *
 * The target's `dbProps` live on its full PageDoc, not on PageMeta, so this
 * reads it through the ordinary `usePage` hook — which works identically in
 * all three data modes.
 */
/**
 * AI column editor. Only picks *what* to generate — generation itself is
 * per-row and on demand (see AiCell), because each fill is a paid model call
 * and re-running the whole column on a config change would be a nasty
 * surprise. Existing values stay put when the kind changes; the user
 * regenerates the rows they care about.
 */
function AiConfig({
  prop,
  update,
}: {
  prop: DbProp;
  update: (next: DbProp) => void;
}) {
  const kind: AiPropKind = prop.aiKind ?? "summary";
  return (
    <>
      <div className="prop-menu-label">Generate</div>
      {AI_PROP_KINDS.map((k) => (
        <button
          key={k.id}
          className={`menu-item ${kind === k.id ? "active" : ""}`}
          onClick={() => update({ ...prop, aiKind: k.id })}
          title={k.hint}
        >
          {k.label}
        </button>
      ))}
      {kind === "custom" && (
        <textarea
          className="formula-input"
          rows={3}
          placeholder="e.g. Extract the customer name, or Nothing if absent"
          value={prop.aiPrompt ?? ""}
          onChange={(e) => update({ ...prop, aiPrompt: e.target.value })}
        />
      )}
      <div className="formula-hint">
        Values are generated per row from that page's content, then stored.
      </div>
    </>
  );
}

/**
 * Formula editor. Validation is live but non-blocking: the text is saved as
 * typed (so a half-written expression survives closing the menu) and an
 * invalid one simply shows the parser's message and renders as "Error" in
 * the column.
 */
function FormulaConfig({
  prop,
  dbProps,
  update,
}: {
  prop: DbProp;
  dbProps: DbProp[];
  update: (next: DbProp) => void;
}) {
  const [text, setText] = useState(prop.formula ?? "");
  const error = checkFormula(text);
  // Every property except this one is referenceable, plus the title.
  const names = ["Name", ...dbProps.filter((p) => p.id !== prop.id).map((p) => p.name)];

  return (
    <>
      <div className="prop-menu-label">Formula</div>
      <textarea
        className="formula-input"
        rows={3}
        spellCheck={false}
        placeholder={'prop("Price") * prop("Qty")'}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          update({ ...prop, formula: e.target.value });
        }}
      />
      {error ? (
        <div className="formula-error">{error}</div>
      ) : (
        <div className="formula-hint">
          if · concat · round · dateDiff · dateAdd · today · min · max · sum
        </div>
      )}
      {names.length > 0 && (
        <>
          <div className="prop-menu-label">Insert property</div>
          <div className="formula-chips">
            {names.map((name, i) => (
              <button
                key={`${name}-${i}`}
                className="formula-chip"
                onClick={() => {
                  const next = `${text}${text && !/[\s(,]$/.test(text) ? " " : ""}prop("${name}")`;
                  setText(next);
                  update({ ...prop, formula: next });
                }}
              >
                {name || "Untitled"}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function RollupConfig({
  prop,
  dbProps,
  update,
}: {
  prop: DbProp;
  dbProps: DbProp[];
  update: (next: DbProp) => void;
}) {
  const relations = dbProps.filter((p) => p.type === "relation");
  const chosen = relations.find((p) => p.id === prop.relationPropId);
  const targetDb = usePage((chosen?.targetId as never) ?? null);
  const targetProps = targetDb?.dbProps ?? [];

  return (
    <>
      <div className="prop-menu-label">Relation</div>
      <div className="prop-options">
        {relations.map((r) => (
          <button
            key={r.id}
            className={`menu-item ${r.id === prop.relationPropId ? "active" : ""}`}
            onClick={() =>
              update({
                ...prop,
                relationPropId: r.id,
                // Target changed — the old property id is meaningless now.
                rollupPropId: undefined,
              })
            }
          >
            <span className="menu-icon">
              <GitBranch size={15} />
            </span>
            <span>{r.name}</span>
          </button>
        ))}
        {relations.length === 0 && (
          <div className="select-empty">
            Add a relation property first — a rollup summarises the rows it
            links to.
          </div>
        )}
      </div>

      {chosen && (
        <>
          <div className="prop-menu-label">Property</div>
          <div className="prop-options">
            <button
              className={`menu-item ${prop.rollupPropId === "__title" ? "active" : ""}`}
              onClick={() => update({ ...prop, rollupPropId: "__title" })}
            >
              <span className="menu-icon">
                <Type size={15} />
              </span>
              <span>Name</span>
            </button>
            {targetProps.map((tp) => (
              <button
                key={tp.id}
                className={`menu-item ${tp.id === prop.rollupPropId ? "active" : ""}`}
                onClick={() => update({ ...prop, rollupPropId: tp.id })}
              >
                <span className="menu-icon">{PROP_TYPE_META[tp.type].icon}</span>
                <span>{tp.name}</span>
              </button>
            ))}
            {!targetDb && (
              <div className="select-empty">Loading related database…</div>
            )}
          </div>

          <div className="prop-menu-label">Calculate</div>
          <div className="prop-options">
            {ROLLUP_CALCS.map((c) => (
              <button
                key={c.id}
                className={`menu-item ${(prop.rollupCalc ?? "count") === c.id ? "active" : ""}`}
                onClick={() => update({ ...prop, rollupCalc: c.id as RollupCalc })}
              >
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function OptionRow({
  option,
  onChange,
  onRemove,
}: {
  option: SelectOption;
  onChange: (o: SelectOption) => void;
  onRemove: () => void;
}) {
  const [colorOpen, setColorOpen] = useState(false);
  const [name, setName] = useState(option.name);
  return (
    <div className="option-row">
      <button
        className={`color-dot dot-${option.color}`}
        title="Change color"
        onClick={() => setColorOpen((o) => !o)}
      />
      <input
        className="option-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const n = name.trim();
          if (n && n !== option.name) onChange({ ...option, name: n });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <button className="icon-btn small" onClick={onRemove} title="Remove option">
        <X size={13} />
      </button>
      {colorOpen && (
        <div className="color-row">
          {SELECT_COLORS.map((c) => (
            <button
              key={c}
              className={`color-dot dot-${c} ${c === option.color ? "ring" : ""}`}
              onClick={() => {
                onChange({ ...option, color: c });
                setColorOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddOption({ onAdd }: { onAdd: (name: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      className="option-add"
      placeholder="+ Add option"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) {
          onAdd(value.trim());
          setValue("");
        }
      }}
    />
  );
}
