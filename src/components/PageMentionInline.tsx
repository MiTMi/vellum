import { createReactInlineContentSpec } from "@blocknote/react";
import { useSyncExternalStore } from "react";
import { registrySnapshot, subscribeRegistry } from "../lib/pageRegistry";
import { requestNavigate } from "../state";

/**
 * Notion's inline `@page` mention: a chip that lives *inside* a paragraph
 * rather than as its own block (that's `pageLink`, still used by the
 * "Sub-page"/"Database" slash items).
 *
 * Stores only `pageId`; the title and icon are read live from the page
 * registry so renames propagate. Custom inline content renders outside the
 * app's React tree and can't use context — hence the module registry.
 */
export const PageMentionSpec = createReactInlineContentSpec(
  {
    type: "pageMention" as const,
    propSchema: {
      pageId: { default: "" },
    },
    content: "none" as const,
  },
  {
    render: ({ inlineContent }) => {
      const pageId = inlineContent.props.pageId as string;
      const pages = useSyncExternalStore(subscribeRegistry, registrySnapshot);
      const page = pages.get(pageId);
      const title = page ? page.title || "Untitled" : "Deleted page";
      return (
        <span
          className={`page-mention ${!page ? "missing" : ""}`}
          onClick={() => page && requestNavigate(pageId)}
          data-page-id={pageId}
        >
          <span className="page-mention-icon">
            {page?.icon ?? (page?.type === "database" ? "🗂️" : "📄")}
          </span>
          {title}
        </span>
      );
    },
    // Markdown/HTML export goes through BlockNote's lossy converters; without
    // this a mention would serialize as an empty span.
    toExternalHTML: ({ inlineContent }) => {
      const pageId = inlineContent.props.pageId as string;
      const page = registrySnapshot().get(pageId);
      return <span>{page ? page.title || "Untitled" : "Deleted page"}</span>;
    },
  },
);
