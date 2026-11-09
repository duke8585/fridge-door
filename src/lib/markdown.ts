import { Marked, type Tokens } from "marked";

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * True for hrefs that are safe to render: http(s), mailto, and anything without a scheme
 * (relative paths, "/x", "#x", "?x"). Anything with another scheme (javascript:, data:,
 * vbscript:, or an entity-obfuscated "jav&#x61;script:") is rejected.
 */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (/^[^/?#]*:/.test(h)) return /^(https?|mailto):/i.test(h);
  return true;
}

/** Raw HTML in markdown is escaped and unsafe link/image targets become "#", so comments cannot inject script. */
export const md = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: { html: ({ text }) => escape(text) },
  walkTokens(token) {
    if ((token.type === "link" || token.type === "image") && !isSafeHref(token.href)) token.href = "#";
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src) as string;
}

export function renderMarkdownInline(src: string): string {
  return md.parseInline(src) as string;
}

/** Split steps markdown into individual steps (list items, else paragraphs) for cooking mode. */
export function splitSteps(src: string): string[] {
  const tokens = md.lexer(src);
  const list = tokens.find((t): t is Tokens.List => t.type === "list");
  if (list) return list.items.map((i) => i.text.trim());
  return src
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
