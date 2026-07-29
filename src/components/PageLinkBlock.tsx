import { createReactBlockSpec } from "@blocknote/react";
import { useSyncExternalStore } from "react";
import { FileText, Database } from "lucide-react";
import {
  registrySnapshot,
  subscribeRegistry,
} from "../lib/pageRegistry";
import { requestNavigate } from "../state";

/**
 * A Notion-style sub-page link block. Stores only the pageId; title and
 * icon are looked up live from the page registry so renames propagate.
 */
export const PageLinkSpec = createReactBlockSpec(
  {
    type: "pageLink" as const,
    propSchema: {
      pageId: { default: "" },
    },
    content: "none" as const,
  },
  {
    render: (props) => {
      const pageId = props.block.props.pageId as string;
      const pages = useSyncExternalStore(subscribeRegistry, registrySnapshot);
      const page = pages.get(pageId);
      const title = page ? page.title || "Untitled" : "Deleted page";
      return (
        <div
          className={`page-link-block ${!page ? "missing" : ""}`}
          onClick={() => page && requestNavigate(pageId)}
          contentEditable={false}
        >
          <span className="page-link-icon">
            {page?.icon ? (
              page.icon
            ) : page?.type === "database" ? (
              <Database size={16} />
            ) : (
              <FileText size={16} />
            )}
          </span>
          <span className="page-link-title">{title}</span>
        </div>
      );
    },
  },
);
