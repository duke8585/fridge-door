import type { Stars as StarsT } from "../../shared/schema";

export function StarsInput({ value, onChange }: { value?: number; onChange: (s: StarsT) => void }) {
  return (
    <span className="stars-input" role="radiogroup" aria-label="Your rating">
      {([1, 2, 3, 4, 5] as const).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          className={value !== undefined && n <= value ? "on" : ""}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export function AvgStars({ avg, count }: { avg: number | null; count: number }) {
  if (avg === null) return <span className="muted small">no ratings</span>;
  return (
    <span className="avg-stars small" title={`${avg} from ${count}`}>
      ★ {avg.toFixed(1)} <span className="muted">({count})</span>
    </span>
  );
}
