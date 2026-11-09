import type { ReactNode } from "react";
import { parseTag } from "../../shared/tags";

/**
 * A tag as "group value": the group as a small coloured label (colours per group in styles.css,
 * light and dark), then the value. A tag outside the scheme shows as written, with no group.
 */
export function TagLabel({ tag }: { tag: string }) {
  const p = parseTag(tag);
  if (!p) return <span className="tag-value">{tag}</span>;
  return (
    <>
      <span className="tag-group" data-group={p.group}>
        {p.group}
      </span>
      <span className="tag-sep">:</span>
      <span className="tag-value">{p.value}</span>
    </>
  );
}

/**
 * A chip with an optional remove button (`onRemove`) or extra content (`children`). `armed` shows
 * the button as "remove?" for callers that want a second tap before removing.
 */
export function TagChip({
  tag,
  on,
  invalid,
  armed,
  onRemove,
  children,
}: {
  tag: string;
  on?: boolean;
  invalid?: boolean;
  armed?: boolean;
  onRemove?: () => void;
  children?: ReactNode;
}) {
  const group = parseTag(tag)?.group;
  return (
    <span className={`chip tag-chip${on ? " on" : ""}${invalid ? " invalid" : ""}${armed ? " armed" : ""}`} data-group={group}>
      <TagLabel tag={tag} />
      {children}
      {onRemove && (
        <button type="button" aria-label={armed ? `Tap again to remove tag ${tag}` : `Remove tag ${tag}`} onClick={onRemove}>
          {armed ? "remove?" : "×"}
        </button>
      )}
    </span>
  );
}
