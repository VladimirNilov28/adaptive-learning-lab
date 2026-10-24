import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./code-block";

type Node = { type: string; value?: string; children?: Node[]; data?: { hProperties?: Record<string, unknown> } };
const calloutKinds = new Set(["note", "tip", "important", "warning", "caution"]);

/** Turns GitHub-style `> [!NOTE]` blockquotes into labelled callouts (no raw HTML involved). */
function remarkCallouts() {
  const visit = (node: Node) => {
    if (node.type === "blockquote") {
      const paragraph = node.children?.[0], text = paragraph?.children?.[0];
      const match = text?.type === "text" ? /^\[!(\w+)\]\s*/.exec(text.value ?? "") : null;
      const kind = match?.[1].toLowerCase();
      if (match && kind && calloutKinds.has(kind) && text) {
        text.value = text.value!.slice(match[0].length);
        node.data = { ...node.data, hProperties: { className: `callout callout-${kind}`, "data-callout": kind } };
      }
    }
    node.children?.forEach(visit);
  };
  return (tree: Node) => visit(tree);
}

const components: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  a: ({ node: _node, href = "", ...props }) => /^https?:\/\//i.test(href) ?
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...props} /> : <a href={href} {...props} />,
  table: ({ node: _node, ...props }) => <div className="table-wrap"><table {...props} /></div>,
};

export function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCallouts]}
    rehypePlugins={[rehypeHighlight]} components={components} skipHtml>{children}</ReactMarkdown></div>;
}
