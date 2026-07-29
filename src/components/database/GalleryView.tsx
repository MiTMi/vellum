import { Plus } from "lucide-react";
import { PageDoc, PageMeta } from "../../lib/types";
import { useMutations } from "../../data";
import { usePagesIndex } from "../../hooks/usePagesIndex";
import { requestPeek, useNav } from "../../state";
import { coverBackground } from "../../lib/colors";
import CardProps from "./CardProps";

/**
 * Notion's gallery view: rows as cards, each showing its cover (or a tinted
 * placeholder), icon, title and the first few property values.
 */
export default function GalleryView({
  page,
  rows,
  locked,
}: {
  page: PageDoc;
  rows: PageMeta[];
  locked?: boolean;
}) {
  const mutations = useMutations();
  const index = usePagesIndex();
  const { navigate } = useNav();
  const dbProps = page.dbProps ?? [];
  const cardProps = dbProps.filter((p) => p.type !== "checkbox").slice(0, 3);

  return (
    <div className="gallery-view">
      {rows.map((row) => (
        <button
          key={row._id}
          className="gallery-card"
          onClick={() => requestPeek(row._id)}
        >
          <div
            className={`gallery-cover ${row.cover ? "" : "empty"}`}
            style={
              row.cover ? { background: coverBackground(row.cover) } : undefined
            }
          >
            {!row.cover && <span className="gallery-cover-icon">{row.icon ?? "📄"}</span>}
          </div>
          <div className="gallery-card-body">
            <div className="gallery-card-title">
              {row.cover && <span className="row-icon">{row.icon ?? "📄"}</span>}
              <span>{row.title || "Untitled"}</span>
            </div>
            <CardProps
              row={row}
              props={cardProps}
              dbProps={dbProps}
              byId={index.byId}
            />
          </div>
        </button>
      ))}
      {rows.length === 0 && (
        <div className="gallery-empty">No rows yet.</div>
      )}
      {!locked && (
        <button
          className="gallery-card gallery-new"
          onClick={async () => {
            const id = await mutations.create({
              parentId: page._id,
              type: "doc",
            });
            requestPeek(id);
          }}
        >
          <Plus size={16} /> New page
        </button>
      )}
    </div>
  );
}
