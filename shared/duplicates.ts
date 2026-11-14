/** Finding recipes that are probably the same dish, before an import creates a second copy. */
import { TRACKING_PARAM } from "./lint";

/** Same page regardless of http/https, www, trailing slash, host case and tracking parameters. */
export function normalizeSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...url.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}${query}`;
}

const normalizeTitle = (t: string): string =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const compact = s.replace(/ /g, "");
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen-Dice over character bigrams of the normalized titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  const total = [...ga.values(), ...gb.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export const SIMILAR_TITLE = 0.85;

export type DuplicateCandidate = { id: string; title: string; source_url?: string; reason: "same source_url" | "similar title" };

/** Existing recipes with the same normalized source_url or a title at least SIMILAR_TITLE alike. */
export function findDuplicates(
  draft: { title: string; source_url?: string },
  existing: readonly { id: string; title: string; source_url?: string }[],
): DuplicateCandidate[] {
  const url = draft.source_url ? normalizeSourceUrl(draft.source_url) : undefined;
  const out: DuplicateCandidate[] = [];
  for (const r of existing) {
    if (url && r.source_url && normalizeSourceUrl(r.source_url) === url)
      out.push({ id: r.id, title: r.title, source_url: r.source_url, reason: "same source_url" });
    else if (titleSimilarity(draft.title, r.title) >= SIMILAR_TITLE) out.push({ id: r.id, title: r.title, source_url: r.source_url, reason: "similar title" });
  }
  return out;
}

/** The link as stored on an imported recipe: tracking parameters and the fragment removed. */
export function stripTracking(raw: string): string {
  const url = new URL(raw.trim());
  for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(k)) url.searchParams.delete(k);
  url.hash = "";
  return url.href;
}
