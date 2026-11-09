import { useMemo } from "react";
import { renderMarkdown, renderMarkdownInline } from "../lib/markdown";

export { splitSteps } from "../lib/markdown";

export function Markdown({ src, inline }: { src: string; inline?: boolean }) {
  const html = useMemo(() => (inline ? renderMarkdownInline(src) : renderMarkdown(src)), [src, inline]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
