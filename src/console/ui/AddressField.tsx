// ============================================================================
// AddressField - the console's ONE address input.
//
// An address is typed; coordinates are DERIVED from it and never typed. Picking
// a suggestion geocodes, dropping a pin reverse-geocodes. There is no
// coordinates field to contradict the address, and no way to set a point except
// by confirming a place.
//
// A pin, once set, is not thrown away by editing the address: "Unit 4, " typed
// in front of a reverse-geocoded street is a refinement, not a new place, and a
// hand-placed pin on the right gate is the more expensive thing to lose. What
// the field will not do is let the two disagree in silence - a pin whose source
// address no longer matches what is typed says so on screen, and Remove
// location is always one click away. That button is the only way a location
// leaves a record, which is what the coordinate boxes used to be for.
//
// "Pick on map" is the second way IN, not a second field. It opens a draft over
// the same value - move the pin, watch the address follow - and cancelling
// leaves the typed address exactly as it was. Records that keep no coordinates
// (customers, buildings, the org profile) still get it, because finding a place
// on a map is often the fastest way to a correctly spelt address; only the
// address is kept, and the copy says so.
//
// Everything map- and geocoder-shaped is optional AT RUNTIME. With no Mapbox
// token this is a plain labelled text input and there is no map button at all;
// if the map chunk fails to load, the button is disabled with the reason beside
// it. The console must stay usable when a third party is not.
//
// Keyboard: the input alone is a complete path to a valid answer (type, arrow
// to a suggestion, Enter - which fills the address AND its coordinates), so a
// pin is never the only way to express a location. Inside map mode the map
// itself takes focus, where the arrow keys nudge the pin.
// ============================================================================

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { webConfig } from '../../config/env';
import type { GeoPoint } from '../../types';
import { AddressSearch } from './AddressSearch';
import { LocationPicker } from './LocationPicker';
import {
  forwardGeocode,
  formatGeo,
  reverseGeocode,
  type AddressSelection,
} from './geocode';
import styles from './AddressField.module.css';

export interface AddressFieldProps {
  id: string;
  label: string;
  /** The address text. Always what the person typed or picked. */
  value: string;
  onChange: (address: string) => void;
  /**
   * The stored point, for the records that keep one (today: sites). Pass BOTH
   * `geo` and `onGeoChange` or neither: without them the field is address-only
   * and map mode fills the text alone.
   */
  geo?: GeoPoint | null;
  onGeoChange?: (geo: GeoPoint | null) => void;
  disabled?: boolean;
}

/** Below this the geocoder has nothing to work with, so opening the map on a
 *  two-letter address would just be a wasted request. */
const MIN_LOOKUP_LENGTH = 3;
/** A dragged pin fires continuously; only the point it settles near is worth
 *  an address lookup. */
const REVERSE_DEBOUNCE_MS = 400;

export function AddressField({
  id,
  label,
  value,
  onChange,
  geo,
  onGeoChange,
  disabled = false,
}: AddressFieldProps) {
  const token = webConfig.mapboxAccessToken.trim();
  const panelId = useId();
  const hintId = useId();
  const noteId = useId();

  const [mapMode, setMapMode] = useState(false);
  // The draft the map edits. Committed by "Use this location", thrown away by
  // Cancel, so the typed address survives a look at the map unchanged.
  const [draftAddress, setDraftAddress] = useState('');
  const [draftGeo, setDraftGeo] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  // The address text the CURRENT point was confirmed against. Shown once the
  // typed address has moved away from it, so a stale pin is visible rather than
  // silently disagreeing with the address it sits beside.
  const [pinSource, setPinSource] = useState<string | null>(null);

  // Guards the two async lookups against a cancel, a second click, or a slow
  // response arriving after a fresher one.
  const openSeq = useRef(0);
  const reverseSeq = useRef(0);
  const reverseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storesLocation = typeof onGeoChange === 'function';

  // A record loaded from the database arrives with both fields already agreed:
  // its stored address IS where its stored point came from, so an untouched
  // edit reads as pinned rather than stale.
  useEffect(() => {
    if (geo && pinSource === null) {
      setPinSource(value);
    }
  }, [geo, value, pinSource]);

  useEffect(() => {
    return () => {
      if (reverseTimer.current) {
        clearTimeout(reverseTimer.current);
      }
    };
  }, []);

  const stopReverseLookup = () => {
    if (reverseTimer.current) {
      clearTimeout(reverseTimer.current);
      reverseTimer.current = null;
    }
    reverseSeq.current += 1;
  };

  // --- Address mode ---------------------------------------------------------

  const onPicked = (selection: AddressSelection) => {
    // AddressSearch has already reported the text through onChange; all that is
    // left is the point it came with.
    if (!onGeoChange) {
      return;
    }
    setPinSource(selection.address);
    onGeoChange(selection.geo);
  };

  const removeLocation = () => {
    setPinSource(null);
    onGeoChange?.(null);
  };

  // --- Map mode -------------------------------------------------------------

  const openMap = () => {
    const seq = ++openSeq.current;
    setLookupFailed(false);
    setDraftAddress(value);
    setDraftGeo(geo ?? null);
    setMapMode(true);
    const text = value.trim();
    if (geo || text.length < MIN_LOOKUP_LENGTH) {
      return;
    }
    // Open where the typed address is, not on an empty view of Britain. The
    // point comes from that same text, so the two still agree.
    setLocating(true);
    void forwardGeocode(text, token, 1).then((matches) => {
      if (seq !== openSeq.current) {
        return;
      }
      setLocating(false);
      if (matches && matches.length > 0) {
        setDraftGeo(matches[0].geo);
      }
    });
  };

  const closeMap = () => {
    openSeq.current += 1;
    stopReverseLookup();
    setMapMode(false);
    setLocating(false);
  };

  const onPinMoved = (point: GeoPoint) => {
    setDraftGeo(point);
    setLookupFailed(false);
    stopReverseLookup();
    const seq = reverseSeq.current;
    reverseTimer.current = setTimeout(() => {
      void reverseGeocode(point, token).then((address) => {
        if (seq !== reverseSeq.current) {
          return;
        }
        if (address) {
          // The pin is the location; the lookup only supplies the words for it.
          setDraftAddress(address);
        } else {
          setLookupFailed(true);
        }
      });
    }, REVERSE_DEBOUNCE_MS);
  };

  const onDraftTyped = (next: string) => {
    setDraftAddress(next);
    setLookupFailed(false);
    // A lookup from a pin the user has since typed over must not land on top of
    // their words; the pin itself stays where they put it.
    stopReverseLookup();
  };

  const onDraftPicked = (selection: AddressSelection) => {
    setLookupFailed(false);
    stopReverseLookup();
    setDraftAddress(selection.address);
    setDraftGeo(selection.geo);
  };

  const commit = () => {
    onChange(draftAddress);
    if (onGeoChange) {
      setPinSource(draftGeo ? draftAddress : null);
      onGeoChange(draftGeo);
    }
    closeMap();
  };

  // --- Rendering ------------------------------------------------------------

  const canUseMap = token !== '';
  const instruction = storesLocation
    ? 'Click the map, or drag the pin, to set the exact spot — the address updates to match. With the map focused, the arrow keys nudge the pin and Enter drops one in the centre.'
    : 'Find the place on the map to fill in its address. Only the address is saved for this record — click the map, or drag the pin, and the address follows.';
  const confirmLabel = storesLocation ? 'Use this location' : 'Use this address';
  const confirmDisabled = storesLocation
    ? draftGeo === null
    : draftAddress.trim() === '';
  // The address has been edited away from the one the point was confirmed
  // against. Not an error - "Unit 4, " in front of a street is still that
  // street - but never left unsaid either.
  const pinStale =
    pinSource !== null && pinSource.trim() !== '' && pinSource.trim() !== value.trim();

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <div className={styles.search}>
          <AddressSearch
            // Remounted on the mode switch so suggestions raised against the
            // draft cannot sit open over the address they were abandoned for.
            key={mapMode ? 'map' : 'address'}
            id={id}
            label={label}
            value={mapMode ? draftAddress : value}
            onChange={mapMode ? onDraftTyped : onChange}
            onSelect={mapMode ? onDraftPicked : onPicked}
            disabled={disabled}
            describedBy={mapFailed && !mapMode ? noteId : undefined}
          />
        </div>
        {canUseMap && (
          <div className={styles.toggle}>
            <Button
              type="button"
              variant="secondary"
              onClick={mapMode ? closeMap : openMap}
              disabled={disabled || (!mapMode && mapFailed)}
              aria-expanded={mapMode}
              // Only while the panel exists: a control cannot own an element
              // that is not there.
              aria-controls={mapMode ? panelId : undefined}
              aria-describedby={mapFailed && !mapMode ? noteId : undefined}
            >
              {/* Not a bare "Cancel": these forms already have one at the
                  bottom, and two buttons of the same name is one too many. */}
              {mapMode ? 'Cancel map' : 'Pick on map'}
            </Button>
          </div>
        )}
      </div>

      {/* Idle, with a location already pinned: nothing else on screen shows the
          point, so this line is the whole of what the record holds - and the
          only way to take it off again. */}
      {!mapMode && storesLocation && geo && (
        <div className={styles.pinnedRow}>
          <p className={styles.pinned}>
            {pinStale
              ? `Location pinned at ${formatGeo(geo)}, from “${pinSource}”. Remove it if the address above is somewhere else.`
              : `Location pinned at ${formatGeo(geo)}.`}
          </p>
          <Button
            type="button"
            variant="ghost"
            onClick={removeLocation}
            disabled={disabled}
          >
            Remove location
          </Button>
        </div>
      )}

      {!mapMode && mapFailed && (
        <p id={noteId} className={styles.note}>
          The map is unavailable at the moment, so type the address instead — it
          is saved either way.
        </p>
      )}

      {mapMode && (
        <div id={panelId} className={styles.panel}>
          <p id={hintId} className={styles.hint}>
            {instruction}
          </p>
          {locating ? (
            <p className={styles.status} role="status">
              Finding that address on the map
            </p>
          ) : (
            <LocationPicker
              value={draftGeo}
              onChange={onPinMoved}
              onUnavailable={() => setMapFailed(true)}
              describedBy={hintId}
              disabled={disabled}
            />
          )}
          <p className={styles.status} role="status">
            {lookupFailed
              ? 'No address found for that point. Type the address yourself; the pin stays where you put it.'
              : draftGeo
                ? `Pinned at ${formatGeo(draftGeo)}`
                : 'No pin yet. Click the map, or search for the address above.'}
          </p>
          <div className={styles.actions}>
            <Button type="button" onClick={commit} disabled={disabled || confirmDisabled}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
