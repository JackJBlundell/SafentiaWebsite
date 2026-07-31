// ============================================================================
// SearchField - a list's own search box: icon, placeholder, and a clear button
// that appears once there is something to clear.
//
// The console's list screens each grew their own bare <input type="search">
// with a label above it and nothing else. Three things were missing every time:
//
//   1. A PLACEHOLDER saying what is actually searched. "Search customers" as a
//      label tells you the noun; it does not tell you that the name, the
//      address and the contacts are all matched, which is the difference
//      between typing a postcode and not bothering.
//   2. A CLEAR affordance. `type="search"` gets one free in WebKit and nothing
//      at all in Firefox, so on half the browsers the only way back to the full
//      list was selecting the text and deleting it.
//   3. The magnifier. Every other search on the site has one; a plain box in a
//      toolbar reads as a filter field, or as nothing.
//
// The label stays in the DOM and is visually hidden by default: a placeholder is
// NOT a label - it disappears on the first keystroke, and a screen reader that
// meets an unlabelled box in a toolbar has no idea what it searches. Callers
// that want the label visible can ask for it.
// ============================================================================

import { useId } from 'react';
import styles from './SearchField.module.css';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name, e.g. "Search customers". Always present in the DOM. */
  label: string;
  /** What is matched, in the user's words - "Name, address or contact". */
  placeholder: string;
  /** Show the label above the field rather than only to assistive tech. */
  showLabel?: boolean;
  className?: string;
}

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  showLabel = false,
  className = '',
}: SearchFieldProps) {
  const id = useId();

  return (
    <div className={`${styles.field} ${className}`}>
      <label
        className={showLabel ? styles.label : styles.srOnly}
        htmlFor={id}
      >
        {label}
      </label>
      <div className={styles.box}>
        <svg
          viewBox="0 0 18 18"
          className={styles.icon}
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="5" />
          <path d="M12 12l3.5 3.5" />
        </svg>
        <input
          id={id}
          className={styles.input}
          // `text`, not `search`: the browser's own clear affordance exists in
          // WebKit only, sits at a different size in every engine, and cannot be
          // given an accessible name. Ours is below, and it is the same in all
          // of them.
          type="text"
          role="searchbox"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // Escape clears, which is the shortcut people expect of a search box
          // and costs nothing to honour.
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value !== '') {
              event.stopPropagation();
              onChange('');
            }
          }}
        />
        {value !== '' && (
          <button
            type="button"
            className={styles.clear}
            // Names what it clears, not just "Clear": in a toolbar with a filter
            // panel beside it, "Clear" alone is ambiguous out of context.
            aria-label={`Clear ${label.toLowerCase()}`}
            title="Clear"
            onClick={() => onChange('')}
          >
            <svg
              viewBox="0 0 18 18"
              aria-hidden="true"
              focusable="false"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
            >
              <path d="M5 5l8 8M13 5l-8 8" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
