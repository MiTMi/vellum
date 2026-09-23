import { createExtension } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * Right-to-left support in the editor (2026-09-23). Every block gets
 * `dir="auto"`, so each paragraph, heading, list item and checkbox takes
 * its direction from its own first strong character: a Hebrew paragraph
 * lays out right-to-left (bullets, checkboxes and alignment on the right)
 * while the English one under it stays left-to-right. Nothing is stored —
 * direction is derived from the text, so old pages, synced pages and
 * pasted content all get it for free.
 *
 * It is a ProseMirror node decoration rather than a DOM tweak because
 * BlockNote owns the editor's DOM: an attribute written from outside would
 * be clobbered on the next re-render. The decoration lands on each
 * `blockContainer` (`.bn-block-outer`), so the block's nested children
 * resolve their own direction; `src/styles/app.css` mirrors the
 * left-anchored BlockNote layout under `:dir(rtl)`.
 */
const key = new PluginKey<DecorationSet>("vellumAutoDir");

function build(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir: "auto" }));
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

export const autoDirExtension = createExtension(() => ({
  key: "vellumAutoDir",
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
      },
      props: {
        decorations: (state) => key.getState(state),
      },
    }),
  ],
}));
