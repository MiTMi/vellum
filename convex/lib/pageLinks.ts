/**
 * Collect the ids of every page referenced by pageLink blocks in a
 * BlockNote document. Shared by the server `backlinks` query and the
 * client-side replica (offline/mock modes), so both sides agree on what
 * counts as a link.
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
    if (obj.type === "pageLink" && typeof props?.pageId === "string" && props.pageId) {
      out.push(props.pageId);
    }
    if (Array.isArray(obj.children)) walk(obj.children);
    if (Array.isArray(obj.content)) walk(obj.content);
  };
  walk(content);
  return out;
}
