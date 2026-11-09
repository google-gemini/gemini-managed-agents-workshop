import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SHORT_CELL_CHARS = 32;

type HastNode = { type: string; value?: string; children?: HastNode[] };

function textLength(node: HastNode | undefined): number {
  if (!node) return 0;
  if (node.type === "text") return node.value?.length ?? 0;
  return (node.children ?? []).reduce((sum, child) => sum + textLength(child), 0);
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("/") || href.startsWith("#")) return href;
  try {
    const parsed = new URL(href);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Safe by construction: raw HTML is skipped, links are protocol-checked and opened with
// noopener/noreferrer, and images are disallowed to block external tracking pixels.
const components: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const clean = safeHref(href);
    if (!clean) return <span>{children}</span>;
    return (
      <a {...props} href={clean} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table: ({ node: _node, ...props }) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
  td: ({ node, ...props }) => (
    <td {...props} className={textLength(node) <= SHORT_CELL_CHARS ? "cell-short" : "cell-long"} />
  ),
};

const plugins = [remarkGfm];
const disallowed = ["img"];

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} components={components} disallowedElements={disallowed} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
