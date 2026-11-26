/**
 * Splitting the steps markdown into steps. One implementation for the cooking view, the inline
 * ingredient amounts and the lint, so all three count the same steps. No zod here, so the client
 * bundle can import it.
 */
import { Lexer, type Tokens } from "marked";

const tokens = (src: string) => Lexer.lex(src, { gfm: true, breaks: true });

/** True when the whole markdown is one list, so it can be rendered one item at a time without losing text. */
export function isStepList(src: string): boolean {
  const t = tokens(src).filter((x) => x.type !== "space");
  return t.length === 1 && t[0]!.type === "list";
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
