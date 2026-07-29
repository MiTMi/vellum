import React from "react";
import { PageDoc, SelectOption } from "../../lib/types";
import { useMutations } from "../../data";
import Cell from "./Cell";
import { PROP_TYPE_META } from "./PropertyMenu";

/**
 * The Notion-style property panel shown at the top of a database row page.
 * Receives the row and its parent database document.
 */
export default function RowPropsPanel({
  row,
  database,
}: {
  row: PageDoc;
  database: PageDoc;
}) {
  const mutations = useMutations();
  const dbProps = database.dbProps ?? [];
  if (!dbProps.length) return null;

  const addOption = (propId: string, option: SelectOption) => {
    void mutations.updateDbProps({
      id: database._id,
      dbProps: dbProps.map((p) =>
        p.id === propId ? { ...p, options: [...(p.options ?? []), option] } : p,
      ),
    });
  };

  return (
    <div className="row-props">
      {dbProps.map((prop) => (
        <div key={prop.id} className="row-prop">
          <span className="row-prop-name">
            {PROP_TYPE_META[prop.type].icon}
            {prop.name}
          </span>
          <Cell
            rowId={row._id}
            prop={prop}
            value={row.props?.[prop.id]}
            onAddOption={addOption}
            bare
          />
        </div>
      ))}
      <div className="row-props-divider" />
    </div>
  );
}
