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
} from "lucide-react";
import Popover from "../ui/Popover";
import { DbProp, PropType, SelectOption } from "../../lib/types";
import { SELECT_COLORS, randomColor } from "../../lib/colors";
import { uid } from "../../lib/ranks";
import { usePagesList } from "../../data";

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
};

interface PropertyMenuProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  prop: DbProp;
  update: (next: DbProp) => void;
  remove: () => void;
  sort?: (dir: "asc" | "desc" | null) => void;
}

export default function PropertyMenu({
  anchor,
  onClose,
  prop,
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
