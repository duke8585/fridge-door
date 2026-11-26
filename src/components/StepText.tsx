import { useMemo, useState } from "react";
import type { Section } from "../../shared/schema";
import { type Mark, renderStep, sectionLines } from "../lib/stepHtml";

/**
 * One step with the amounts of the ingredients it names. Reading: tap a word for its amount or a
 * section reference for the section's list. Cooking: amounts and lists are always shown.
 */
export function StepText({ step, marks, scaled, cooking }: { step: string; marks: Mark[]; scaled: Section[]; cooking: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const shown = (m: Mark): boolean => cooking || open.has(m.id);
  const html = useMemo(() => renderStep(step, marks, (m) => cooking || open.has(m.id)), [step, marks, cooking, open]);
  const tap = (e: React.MouseEvent): void => {
    if (cooking) return;
    const id = (e.target as Element).closest("[data-s]")?.getAttribute("data-s");
    if (id == null) return;
    const next = new Set(open);
    if (!next.delete(Number(id))) next.add(Number(id));
    setOpen(next);
  };
  return (
    <>
      <div className="md" onClick={tap} dangerouslySetInnerHTML={{ __html: html }} />
      {marks
        .filter((m) => m.kind === "sec" && shown(m))
        .map((m) => (
          <ul key={m.id} className="step-sec">
            {sectionLines(scaled[m.section!]).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ))}
    </>
  );
}
