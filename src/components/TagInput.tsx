import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { addTag, resolveTyped, splitTyped, tagCounts, tagKey, tagOptions } from "../lib/tagInput";
import { TagChip, TagLabel } from "./TagChip";
import { useArmed } from "../lib/armed";
import { useSignal } from "../lib/signal";
import { loadSummaries, summaries } from "../store/recipes";

export type TagValue = { tags: string[]; text: string };

/**
 * Chips plus a combobox suggesting group:value tags: the fixed values and the library's tags in use
 * (from the local store, so it works offline). Options are tap targets, nothing depends on hover.
 * Removing takes two taps: the first arms the chip, the second removes it,
 * so a stray tap on the recipe page, where tags save straight away, cannot drop one.
 * `invalid` is the index of the tag a server validation error points at (`tags.N`). `label` is
 * the visible label; the recipe page passes "Add tag" since its section already says Tags.
 */
export function TagInput({
  value,
  onChange,
  error,
  invalid,
  label = "Tags",
}: {
  value: TagValue;
  onChange: (v: TagValue) => void;
  error?: string;
  invalid?: number;
  label?: string;
}) {
  const id = useId();
  const list = useSignal(summaries);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { armed, tap, disarm } = useArmed<string>();

  useEffect(() => {
    if (!summaries.get()) void loadSummaries();
  }, []);

  const remove = (t: string): void => {
    if (tap(t)) onChange({ tags: value.tags.filter((x) => x !== t), text: value.text });
  };

  const counts = useMemo(() => tagCounts((list ?? []).map((r) => r.tags)), [list]);
  const options = useMemo(() => tagOptions(value.text, counts, value.tags), [value.text, counts, value.tags]);
  const shown = open && options.length > 0;
  const optionId = (i: number): string => `${id}-opt-${i}`;

  const pick = (tag: string, text = ""): void => {
    onChange({ tags: addTag(value.tags, tag), text });
    setActive(-1);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    disarm();
    const action = tagKey(e.key, { text: value.text, options, active, open: shown, resolved: resolveTyped(value.text, counts) });
    if (!action) return;
    e.preventDefault();
    switch (action.type) {
      case "move":
        setOpen(true);
        setActive(action.active);
        break;
      case "pick":
        pick(action.tag);
        break;
      case "close":
        setOpen(false);
        setActive(-1);
    }
  };

  const onType = (raw: string): void => {
    setOpen(true);
    disarm();
    const split = splitTyped(raw, shown ? options[active] : undefined, counts);
    if (split) {
      onChange({ tags: split.picks.reduce(addTag, value.tags), text: split.text.trimStart() });
      setActive(-1);
      return;
    }
    onChange({ tags: value.tags, text: raw });
    setActive(raw.trim() === "" ? -1 : 0);
  };

  return (
    <div className={`field tag-field ${error ? "has-error" : ""}`}>
      <label className="label" htmlFor={`${id}-input`}>
        {label}
      </label>
      <div className="tag-box">
        {value.tags.length > 0 && (
          <ul className="tag-chips" aria-label="Selected tags">
            {value.tags.map((t, i) => (
              <li key={t}>
                <TagChip tag={t} on invalid={i === invalid} armed={armed === t} onRemove={() => remove(t)} />
              </li>
            ))}
          </ul>
        )}
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={shown}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
          aria-invalid={invalid === value.tags.length || undefined}
          aria-describedby={`${id}-hint`}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          value={value.text}
          placeholder={value.tags.length ? "add tag" : "main, indian, list:..."}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
        />
        {shown && (
          <ul id={`${id}-list`} role="listbox" aria-label="Tag suggestions" className="tag-options">
            {options.map((o, i) => (
              <li
                key={`${o.kind}:${o.tag}`}
                id={optionId(i)}
                role="option"
                aria-label={o.kind === "new" ? `${o.tag} (new)` : o.tag}
                aria-selected={i === active}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.tag)}
              >
                <span className="tag-option">
                  <TagLabel tag={o.tag} />
                </span>
                {o.kind === "existing" ? <span className="muted small">{o.count || ""}</span> : <span className="new-tag small">new</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span id={`${id}-hint`} className="muted small">
        Type a value (main, indian) or group: (list:, collection:) to narrow. Enter, Tab or comma adds the highlighted one.
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
