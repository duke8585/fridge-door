/**
 * Splitting the steps markdown into steps. One implementation for the cooking view, the inline
 * ingredient amounts and the lint, so all three count the same steps. No zod here, so the client
 * bundle can import it.
 */
import { Lexer, type Tokens } from "marked";

const tokens = (src: string) => Lexer.lex(src, { gfm: true, breaks: true });

/**
 * True when the whole markdown is one numbered list of plain one-paragraph items, so it can be
 * rendered one item at a time without losing text or structure (nested lists, extra paragraphs).
 */
export function isStepList(src: string): boolean {
  const [list, ...rest] = tokens(src).filter((x) => x.type !== "space");
  if (rest.length || list?.type !== "list") return false;
  const { ordered, items } = list as Tokens.List;
  return ordered && items.every((i) => i.tokens.length === 1 && (i.tokens[0]!.type === "text" || i.tokens[0]!.type === "paragraph"));
}

/** Split steps markdown into individual steps (list items, else paragraphs). */
export function splitSteps(src: string): string[] {
  const list = tokens(src).find((t): t is Tokens.List => t.type === "list");
  if (list) return list.items.map((i) => i.text.trim());
  return src
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
