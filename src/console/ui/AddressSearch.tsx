// ============================================================================
// AddressSearch - a labelled combobox over the Mapbox Geocoding API.
//
// The search is a CONVENIENCE, never a gate: free typing without picking a
// suggestion still yields the raw text (address only, no geo), a blank token
// renders a plain input, and any network failure degrades silently to plain
// typing. Selecting a suggestion fills the input AND reports the coordinates
// through onSelect, so forms can pin the location without a coordinates field.
//
// It is the text half of AddressField, which owns the map half; nothing else
// should reach for it directly, so there is one address control in the console.
//
// The Mapbox call itself lives in geocode.ts, which the map half shares.
// ============================================================================

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { webConfig } from '../../config/env';
import { forwardGeocode, type AddressSelection, type GeocodeMatch } from './geocode';
import styles from './AddressSearch.module.css';

export type { AddressSelection };

export interface AddressSearchProps {
  id: string;
  label: string;
  /** Controlled address text; free typing flows through onChange as-is. */
  value: string;
  onChange: (value: string) => void;
  /** Fired only when a suggestion is picked (click or Enter). */
  onSelect: (selection: AddressSelection) => void;
  disabled?: boolean;
  /** Extra ids for the input's description, e.g. a field-level hint. */
  describedBy?: string;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 3;

/** What the field is doing right now, for the polite status line. `failed` is
 *  deliberately absent: a failed lookup says nothing at all, because the typed
 *  text still stands and an outage two streets away is not the assessor's
 *  problem to read about. */
type SearchStatus = 'idle' | 'searching' | 'empty';

export function AddressSearch({
  id,
  label,
  value,
  onChange,
  onSelect,
  disabled = false,
  describedBy,
}: AddressSearchProps) {
  const token = webConfig.mapboxAccessToken.trim();
  const listId = useId();
  const statusId = useId();
  const [suggestions, setSuggestions] = useState<GeocodeMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request counter: only the latest response may render, so a slow
  // early response can never overwrite a fresher one.
  const requestSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    // Closing must also kill anything pending: clear the debounce timer and
    // bump the request sequence, so neither a queued search nor an in-flight
    // response can reopen the dropdown over a deliberate dismissal or pick.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    requestSeq.current += 1;
    setOpen(false);
    setStatus('idle');
    setActiveIndex(-1);
  }, []);

  // Clear any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Dismiss when focus/clicks leave the combobox entirely.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const search = useCallback(
    async (text: string) => {
      const seq = ++requestSeq.current;
      setStatus('searching');
      const results = await forwardGeocode(text, token);
      if (seq !== requestSeq.current) {
        return;
      }
      if (results === null) {
        // The search is a convenience, never a gate: on failure the field
        // behaves as a plain text input, with no message to act on.
        setSuggestions([]);
        setOpen(false);
        setStatus('idle');
        return;
      }
      setSuggestions(results);
      setOpen(results.length > 0);
      setStatus(results.length === 0 ? 'empty' : 'idle');
      setActiveIndex(-1);
    },
    [token],
  );

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    onChange(next);
    if (!token) {
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    const text = next.trim();
    if (text.length < MIN_QUERY_LENGTH) {
      // Invalidate any in-flight request so a stale response cannot reopen.
      requestSeq.current += 1;
      setSuggestions([]);
      close();
      return;
    }
    timerRef.current = setTimeout(() => {
      void search(text);
    }, DEBOUNCE_MS);
  };

  const pick = (suggestion: GeocodeMatch) => {
    onChange(suggestion.address);
    onSelect({ address: suggestion.address, geo: suggestion.geo });
    setSuggestions([]);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(
        (index) => (index - 1 + suggestions.length) % suggestions.length,
      );
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        // Consume the Enter so it picks the highlighted address rather than
        // submitting the surrounding form.
        event.preventDefault();
        pick(suggestions[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  // Without a token this is a plain address input by design.
  const searchable = token !== '';
  const statusText =
    status === 'searching'
      ? 'Searching addresses'
      : status === 'empty'
        ? 'No matching addresses. The address you type will be used as it is.'
        : '';

  return (
    <div className={styles.root} ref={rootRef}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        type="text"
        autoComplete="off"
        value={value}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
        role={searchable ? 'combobox' : undefined}
        aria-expanded={searchable ? open : undefined}
        aria-controls={searchable ? listId : undefined}
        aria-autocomplete={searchable ? 'list' : undefined}
        aria-describedby={
          [describedBy, searchable ? statusId : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
        aria-activedescendant={
          searchable && open && activeIndex >= 0
            ? `${listId}-option-${activeIndex}`
            : undefined
        }
      />
      {searchable && open && suggestions.length > 0 && (
        <ul id={listId} role="listbox" aria-label={label} className={styles.listbox}>
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.id}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={
                index === activeIndex ? styles.optionActive : styles.option
              }
              // onMouseDown so the pick lands before the input's blur.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
            >
              {suggestion.address}
            </li>
          ))}
        </ul>
      )}
      {/* Always mounted so an insertion is never what has to be announced; the
          stylesheet collapses it while it is empty. */}
      {searchable && (
        <p id={statusId} className={styles.status} role="status">
          {statusText}
        </p>
      )}
    </div>
  );
}
