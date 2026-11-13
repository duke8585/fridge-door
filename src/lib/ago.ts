const UNITS = [
  { label: "y", ms: 365 * 24 * 3600_000 },
  { label: "mo", ms: 30 * 24 * 3600_000 },
  { label: "d", ms: 24 * 3600_000 },
  { label: "h", ms: 3600_000 },
  { label: "min", ms: 60_000 },
] as const;

/** "3 h ago", "2 d ago": the largest whole unit only. Under a minute, or a clock ahead of ours, is "just now". */
export function ago(iso: string, now: number = Date.now()): string {
  const diff = now - Date.parse(iso);
  const unit = UNITS.find((u) => diff >= u.ms);
  return unit ? `${Math.floor(diff / unit.ms)} ${unit.label} ago` : "just now";
}

/** "13 Nov 2026" */
export const formatDate = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
