import React, { useMemo, useState } from "react";
import { Check } from "lucide-react";
import Popover from "../ui/Popover";
import { DbProp, SelectOption } from "../../lib/types";
import { randomColor } from "../../lib/colors";
import { uid } from "../../lib/ranks";

interface SelectPopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  prop: DbProp;
  /** currently selected option ids */
  value: string[];
  multi: boolean;
  onToggle: (optionId: string, selected: boolean) => void;
  /** called when the user creates a new option (already appended) */
  onCreateOption: (option: SelectOption) => void;
}

export default function SelectPopover({
  anchor,
  onClose,
  prop,
  value,
  multi,
  onToggle,
  onCreateOption,
}: SelectPopoverProps) {
  const [term, setTerm] = useState("");
  const options = prop.options ?? [];

  const filtered = useMemo(
    () =>
      options.filter((o) =>
        o.name.toLowerCase().includes(term.trim().toLowerCase()),
      ),
    [options, term],
  );

  const exact = options.some(
    (o) => o.name.toLowerCase() === term.trim().toLowerCase(),
  );

  const create = () => {
    const name = term.trim();
    if (!name) return;
    const option: SelectOption = { id: uid(), name, color: randomColor() };
    onCreateOption(option);
    onToggle(option.id, true);
    setTerm("");
    if (!multi) onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={260} className="select-popover">
      <input
        className="select-search"
        autoFocus
        placeholder={multi ? "Search or create…" : "Select an option…"}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && term.trim() && !exact) create();
        }}
      />
      <div className="select-options">
        {filtered.map((o) => {
          const selected = value.includes(o.id);
          return (
            <button
              key={o.id}
              className="select-option-row"
              onClick={() => {
                onToggle(o.id, !selected);
                if (!multi) onClose();
              }}
            >
              <span className={`chip chip-${o.color}`}>{o.name}</span>
              {selected && <Check size={14} />}
            </button>
          );
        })}
        {term.trim() && !exact && (
          <button className="select-option-row create" onClick={create}>
            Create <span className={`chip chip-gray`}>{term.trim()}</span>
          </button>
        )}
        {filtered.length === 0 && !term.trim() && (
          <div className="select-empty">Type to create an option</div>
        )}
      </div>
    </Popover>
  );
}
