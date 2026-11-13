/** Outline when off, filled in the accent colour when on. */
export function BookmarkButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const label = on ? "Remove bookmark" : "Bookmark";
  return (
    <button type="button" className="bookmark-button" aria-pressed={on} aria-label={label} title={label} onClick={onToggle}>
      <svg viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 3.75h10a1 1 0 0 1 1 1V20.5l-6-4.2-6 4.2V4.75a1 1 0 0 1 1-1Z" />
      </svg>
    </button>
  );
}
