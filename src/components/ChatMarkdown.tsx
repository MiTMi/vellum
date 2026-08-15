import { Fragment } from "react";
import {
  ChatBlock,
  InlineNode,
  parseChatMarkdown,
} from "../lib/chatMarkdown";

/**
 * Renders an AI chat message's markdown as real elements. Consumes the
 * typed tree from chatMarkdown.ts — everything the model wrote lands as
 * text nodes, never markup, so there is no sanitization to get wrong.
 * Links open in a new tab like the panel's web-citation chips.
 */

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "bold":
            return <strong key={i}>{n.text}</strong>;
          case "italic":
            return <em key={i}>{n.text}</em>;
          case "code":
            return <code key={i}>{n.text}</code>;
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer">
                {n.text}
              </a>
            );
          default:
            return <Fragment key={i}>{n.text}</Fragment>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case "heading": {
      const H = (["h1", "h2", "h3"] as const)[block.level - 1];
      return (
        <H>
          <Inline nodes={block.inline} />
        </H>
      );
    }
    case "quote":
      return (
        <blockquote>
          <Inline nodes={block.inline} />
        </blockquote>
      );
    case "bullets":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "numbered":
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr />;
    default:
      return (
        <p>
          <Inline nodes={block.inline} />
        </p>
      );
  }
}

export default function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="ai-md">
      {parseChatMarkdown(text).map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
