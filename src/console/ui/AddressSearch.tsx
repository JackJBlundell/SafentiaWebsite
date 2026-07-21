// ============================================================================
// AddressSearch - a labelled combobox over the Mapbox Geocoding API.
//
// The search is a CONVENIENCE, never a gate: free typing without picking a
// suggestion still yields the raw text (address only, no geo), a blank token
// renders a plain input, and any network failure degrades silently to plain
// typing. Selecting a suggestion fills the input AND reports the coordinates
// through onSelect, so forms can pin the location without a coordinates field.
//
// This is the console's only third-party call besides Firebase / reCAPTCHA;
// the Privacy policy names it. Only the typed search text leaves the browser.
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
import type { GeoPoint } from '../../types';
import styles from './AddressSearch.module.css';

/** What picking a suggestion yields: the display address plus its point. */
export interface AddressSelection {
  address: string;
  geo: GeoPoint;
}

export interface AddressSearchProps {
  id: string;
  label: string;
  /** Controlled address text; free typing flows through onChange as-is. */
  value: string;
  onChange: (value: string) => void;
  /** Fired only when a suggestion is picked (click or Enter). */
  onSelect: (selection: AddressSelection) => void;
  disabled?: boolean;
}

interface Suggestion {
  id: string;
  placeName: string;
  geo: GeoPoint;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 3;

/** The shape we read from a Mapbox geocoding response; everything else in the
 *  payload is ignored. */
interface MapboxFeature {
  id?: string;
  place_name?: string;
  center?: [number, number];
}

function toSuggestions(payload: unknown): Suggestion[] {
  const features = (payload as { features?: MapboxFeature[] })?.features;
  if (!Array.isArray(features)) {
    return [];
  }
  const suggestions: Suggestion[] = [];
  for (const feature of features) {
    if (
      typeof feature?.place_name === 'string' &&
      Array.isArray(feature.center) &&
      typeof feature.center[0] === 'number' &&
      typeof feature.center[1] === 'number'
    ) {
      suggestions.push({
        id: feature.id ?? `${feature.center[0]},${feature.center[1]}`,
        placeName: feature.place_name,
        // Mapbox centres are [lng, lat].
        geo: { lat: feature.center[1], lng: feature.center[0] },
      });
    }
  }
  return suggestions;
}

export function AddressSearch({
  id,
  label,
  value,
  onChange,
  onSelect,
  disabled = false,
}: AddressSearchProps) {
  const token = webConfig.mapboxAccessToken.trim();
  const listId = useId();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
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
    async (query: string) => {
      const seq = ++requestSeq.current;
      try {
        const response = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
            query,
          )}.json?access_token=${encodeURIComponent(
            token,
          )}&country=gb&limit=5&types=address,postcode,place`,
        );
        if (!response.ok) {
          throw new Error(`Geocoding failed: ${response.status}`);
        }
        const payload: unknown = await response.json();
        if (seq !== requestSeq.current) {
          return;
        }
        const results = toSuggestions(payload);
        setSuggestions(results);
        setOpen(results.length > 0);
        setActiveIndex(-1);
      } catch (error) {
        // The search is a convenience, never a gate: on any failure the field
        // silently behaves as a plain text input - but the failure is logged,
        // because "silently" must never mean "undiagnosable".
        console.warn('[Safentia] address search unavailable', error);
        if (seq === requestSeq.current) {
          setSuggestions([]);
          setOpen(false);
        }
      }
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
    const query = next.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      // Invalidate any in-flight request so a stale response cannot reopen.
      requestSeq.current += 1;
      setSuggestions([]);
      close();
      return;
    }
    timerRef.current = setTimeout(() => {
      void search(query);
    }, DEBOUNCE_MS);
  };

  const pick = (suggestion: Suggestion) => {
    onChange(suggestion.placeName);
    onSelect({ address: suggestion.placeName, geo: suggestion.geo });
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
              {suggestion.placeName}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
