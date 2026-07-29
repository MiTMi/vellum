/**
 * Node types that reference another page: the standalone `pageLink` block
 * and the inline `pageMention` chip. Kept here so the backlink extractor and
 * the replica's temp-id rewriter can never drift apart.
 */
export const PAGE_REF_TYPES = ["pageLink", "pageMention"];

/**
 * Collect the ids of every page referenced by a BlockNote document. Shared
 * by the server `backlinks` query and the client-side replica (offline/mock
 * modes), so both sides agree on what counts as a link.
 */
export function extractPageLinks(content: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const props = obj.props as Record<string, unknown> | undefined;
    if (
      typeof obj.type === "string" &&
      PAGE_REF_TYPES.includes(obj.type) &&
      typeof props?.pageId === "string" &&
      props.pageId
    ) {
      out.push(props.pageId);
    }
    if (Array.isArray(obj.children)) walk(obj.children);
    if (Array.isArray(obj.content)) walk(obj.content);
  };
  walk(content);
  return out;
}
