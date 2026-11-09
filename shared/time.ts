import type { Time } from "./schema";

/** 45 -> "45 min", 90 -> "1 h 30 min", 120 -> "2 h". */
export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "45 min (20 active)", "1 h 30 min (1 h active)". */
export function formatTime(t: Time): string {
  if (t.active_min === undefined) return formatMinutes(t.total_min);
  const active = t.active_min < 60 ? String(t.active_min) : formatMinutes(t.active_min);
  return `${formatMinutes(t.total_min)} (${active} active)`;
}

export type TimeFilter = { id: string; label: string; matches: (totalMin: number) => boolean };

/** List filter chips. A recipe without a time matches none of them. */
export const TIME_FILTERS: readonly TimeFilter[] = [
  { id: "15", label: "≤15 min", matches: (m) => m <= 15 },
  { id: "30", label: "≤30", matches: (m) => m <= 30 },
  { id: "60", label: "≤60", matches: (m) => m <= 60 },
  { id: "longer", label: "longer", matches: (m) => m > 60 },
];

export function matchesTimeFilter(time: Time | undefined, filterId: string | null): boolean {
  if (filterId === null) return true;
  const f = TIME_FILTERS.find((x) => x.id === filterId);
  return f !== undefined && time !== undefined && f.matches(time.total_min);
}
