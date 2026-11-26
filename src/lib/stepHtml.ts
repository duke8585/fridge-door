import { formatQty } from "../../shared/scale";
import type { Section } from "../../shared/schema";
import type { Span } from "../../shared/stepLinks";
import { renderMarkdownInline } from "./markdown";

/** What the reader sees for one span: the word's kind and the amount that follows it. */
export type Mark = { id: number; from: number; to: number; kind: "ing" | "sec" | "amb"; pill: string; section?: number };

const amount = (g: { qty?: number; qtyMax?: number; unit?: Parameters<typeof formatQty>[2] }) => formatQty(g.qty, g.qtyMax, g.unit);

/** Spans worth showing, with their amount text. Lines without a qty ("salt to taste") and empty sections drop out. */
export function stepMarks(spans: readonly Span[], sections: readonly Section[]): Mark[] {
  const out: Mark[] = [];
  spans.forEach((s, id) => {
    const at = { id, from: s.from, to: s.to };
    if (s.kind === "ingredient") {
      if (s.line.qty !== undefined) out.push({ ...at, kind: "ing", pill: `${s.partial ? "of " : ""}${amount(s.line)}` });
    } else if (s.kind === "ambiguous") {
      const amounts = [...new Set(s.lines.filter((l) => l.qty !== undefined).map(amount))];
      if (amounts.length) out.push({ ...at, kind: "amb", pill: amounts.join(" or ") });
    } else if (sections[s.section]?.ingredients.length) out.push({ ...at, kind: "sec", pill: "", section: s.section });
  });
  return out;
}

/** A section's lines as "75 g butter", for the list under a step that refers to the section. */
export function sectionLines(section: Section | undefined): string[] {
  return (section?.ingredients ?? []).map((g) => [amount(g), g.item].filter(Boolean).join(" "));
}

const OPEN = "\uE000";
const MID = "\uE001";
const CLOSE = "\uE002";
const MARKERS = /[\uE000-\uE002]/;
const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * One step as inline HTML, with the marks wrapped in spans. Markers go into the markdown source
 * around each word, so bold and links around it keep working; afterwards each marker pair that
 * sits whole inside one text node (not in a link, code or attribute) becomes the span, and the
 * rest are dropped. If the markers changed anything else, the step renders without marks.
 */
export function renderStep(src: string, marks: readonly Mark[], showPill: (m: Mark) => boolean): string {
  const plain = renderMarkdownInline(src);
  if (!marks.length || MARKERS.test(src)) return plain;
  let source = "";
  let at = 0;
  for (const m of marks) {
    source += src.slice(at, m.from) + OPEN + m.id + MID + src.slice(m.from, m.to) + CLOSE;
    at = m.to;
  }
  const html = renderMarkdownInline(source + src.slice(at));
  if (html.replace(/\uE000\d+\uE001|\uE002/g, "") !== plain) return plain;
  const byId = new Map(marks.map((m) => [m.id, m]));
  let skip = 0;
  return html.replace(/<[^>]*>|[^<]+/g, (piece) => {
    if (piece.startsWith("<")) {
      const tag = /^<(\/?)(a|code)\b/.exec(piece);
      if (tag) skip += tag[1] ? -1 : 1;
      return piece.replace(/[\uE000-\uE002]|\d+(?=\uE001)/g, "");
    }
    return piece
      .replace(/\uE000(\d+)\uE001([^\uE000-\uE002]*)\uE002/g, (_whole, id: string, word: string) => {
        const m = byId.get(Number(id));
        if (!m || skip > 0) return word;
        const pill = m.pill && showPill(m) ? `<span class="amt">${escape(m.pill)}</span>` : "";
        return `<span class="${m.kind}" data-s="${m.id}">${word}</span>${pill}`;
      })
      .replace(/[\uE000-\uE002]|\d+(?=\uE001)/g, "");
  });
}
