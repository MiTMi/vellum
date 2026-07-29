import React from "react";
import Popover from "./Popover";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}

interface MenuProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  items: (MenuItem | "divider")[];
  align?: "left" | "right";
}

export default function Menu({ anchor, onClose, items, align = "left" }: MenuProps) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} className="menu">
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            className={`menu-item ${item.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.icon && <span className="menu-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </Popover>
  );
}
