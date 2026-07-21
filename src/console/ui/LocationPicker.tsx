// ============================================================================
// LocationPicker - a draggable map pin that sets a precise site location.
//
// Addresses geocode to the centre of a street or postcode, which is rarely the
// gate an assessor needs to arrive at. This component lets the pin be placed
// exactly, while the caller's latitude/longitude inputs stay the keyboard path
// and the single source of truth: this is a controlled component, so every pin
// movement leaves through onChange and comes back as `value`.
//
// mapbox-gl is loaded with a dynamic import so it never enters the main bundle
// (it is far larger than the console itself) and never executes during the
// pre-render pass, which has no DOM. A blank Mapbox token renders the guidance
// line and no map at all, exactly as AddressSearch degrades to a plain input.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';
import { webConfig } from '../../config/env';
import type { GeoPoint } from '../../types';
import { AddressSearch } from './AddressSearch';
import styles from './LocationPicker.module.css';

export interface LocationPickerProps {
  /** The pinned point, or null when this site has no coordinates yet. */
  value: GeoPoint | null;
  /** Fired on every pin movement: map click, drag, or a search result pick. */
  onChange: (geo: GeoPoint) => void;
  /** Unique id for the on-map search box; forms may render more than one. */
  searchId: string;
  disabled?: boolean;
}

/** Roughly the whole of Great Britain, used until we have a point to show. */
const UK_CENTRE: [number, number] = [-2.5, 54.0];
const UK_ZOOM = 4.6;
/** Close enough to distinguish one entrance from the next. */
const PINNED_ZOOM = 17;
/** An address or postcode pick lands near, not on, the target. */
const SEARCH_ZOOM = 16;

/** Six decimal places is about 0.1m, well past the precision of a dragged pin,
 *  and keeps the stored value short and comparable. */
function round(coordinate: number): number {
  return Math.round(coordinate * 1e6) / 1e6;
}

function toGeo(lngLat: { lng: number; lat: number }): GeoPoint {
  return { lat: round(lngLat.lat), lng: round(lngLat.lng) };
}

export function LocationPicker({
  value,
  onChange,
  searchId,
  disabled = false,
}: LocationPickerProps) {
  const token = webConfig.mapboxAccessToken.trim();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<MapboxMarker | null>(null);
  const [searchText, setSearchText] = useState('');
  const [failed, setFailed] = useState(false);

  // Held in refs so the map is built exactly once: rebuilding it on every
  // keystroke in the coordinate inputs would flicker and lose the user's zoom.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Read once the map chunk has loaded rather than snapshotted at mount: an
  // edit form prefills from a live query, so the pin often arrives a tick or
  // two after the first render.
  const valueRef = useRef(value);
  valueRef.current = value;
  // A pin being dragged is already under the cursor; echoing the controlled
  // value back onto it mid-gesture fights the drag.
  const draggingRef = useRef(false);

  // Places (or moves) the pin, creating the marker on first use so an unset
  // location never shows a pin stranded at 0,0.
  const placeRef = useRef<(geo: GeoPoint) => void>(() => undefined);

  useEffect(() => {
    if (!token) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;

    const build = async () => {
      const mapboxgl = (await import('mapbox-gl')).default;
      await import('mapbox-gl/dist/mapbox-gl.css');
      // The effect can be torn down while the chunk is still downloading.
      if (cancelled) {
        return;
      }
      mapboxgl.accessToken = token;
      const start = valueRef.current;
      const map = new mapboxgl.Map({
        container,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: start ? [start.lng, start.lat] : UK_CENTRE,
        zoom: start ? PINNED_ZOOM : UK_ZOOM,
        // The map is a pointing device, not a document; keyboard users work in
        // the coordinate inputs, so trapping arrow keys here helps nobody.
        keyboard: false,
        attributionControl: true,
      });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }));

      const place = (geo: GeoPoint) => {
        if (!markerRef.current) {
          const marker = new mapboxgl.Marker({ draggable: true, color: '#c0392b' })
            .setLngLat([geo.lng, geo.lat])
            .addTo(map);
          marker.on('dragstart', () => {
            draggingRef.current = true;
          });
          // Report during the drag, not only at the end, so the coordinate
          // inputs read as a live position readout.
          marker.on('drag', () => {
            onChangeRef.current(toGeo(marker.getLngLat()));
          });
          marker.on('dragend', () => {
            draggingRef.current = false;
            onChangeRef.current(toGeo(marker.getLngLat()));
          });
          markerRef.current = marker;
          return;
        }
        markerRef.current.setLngLat([geo.lng, geo.lat]);
      };
      placeRef.current = place;
      if (start) {
        place(start);
      }

      // Clicking is the forgiving way to place a pin; dragging alone means
      // hunting for a marker that may not exist yet.
      map.on('click', (event) => {
        if (disabledRef.current) {
          return;
        }
        const geo = toGeo(event.lngLat);
        place(geo);
        onChangeRef.current(geo);
      });
    };

    void build().catch((error: unknown) => {
      // Losing the map must never lose the form: the coordinate inputs still
      // work, so we explain the gap rather than throwing it at the user.
      console.warn('[Safentia] map picker unavailable', error);
      if (!cancelled) {
        setFailed(true);
      }
    });

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      // mapbox-gl holds WebGL contexts and window listeners until removed.
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [token]);

  // Keep the pin in step with the controlled value, so typing coordinates by
  // hand moves the marker just as dragging it moves the numbers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || draggingRef.current) {
      return;
    }
    if (!value) {
      // Emptying the coordinate fields means "no location", so the pin goes
      // too; the next placement builds a fresh marker.
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    placeRef.current(value);
    // Only chase the pin when it has left the view; otherwise a small manual
    // correction would yank the map away from what the user is looking at.
    if (!map.getBounds()?.contains([value.lng, value.lat])) {
      map.easeTo({ center: [value.lng, value.lat], zoom: PINNED_ZOOM });
    }
  }, [value]);

  useEffect(() => {
    markerRef.current?.setDraggable(!disabled);
  }, [disabled]);

  const instruction = value
    ? 'Drag the pin, or click the map, to adjust the exact location. The latitude and longitude below update as you move it, and can also be typed in directly.'
    : 'Click the map to drop a pin at the exact location, then drag it to fine-tune. You can also type the latitude and longitude below.';

  if (!token) {
    return (
      <p className={styles.notice}>
        The map picker is unavailable, so enter the latitude and longitude below.
      </p>
    );
  }

  return (
    <div className={styles.root}>
      {!failed && <p className={styles.instruction}>{instruction}</p>}
      <div className={styles.frame}>
        {failed ? (
          <p className={styles.notice}>
            The map could not be loaded. Enter the latitude and longitude below
            instead.
          </p>
        ) : (
          <div className={styles.search}>
            <AddressSearch
              id={searchId}
              label="Find a place on the map"
              value={searchText}
              onChange={setSearchText}
              onSelect={(selection) => {
                setSearchText(selection.address);
                placeRef.current(selection.geo);
                onChange(selection.geo);
                mapRef.current?.flyTo({
                  center: [selection.geo.lng, selection.geo.lat],
                  zoom: SEARCH_ZOOM,
                });
              }}
              disabled={disabled}
            />
          </div>
        )}
        {/* Kept mounted even after a failure: the container ref must stay
            stable for the cleanup that follows. */}
        <div
          ref={containerRef}
          className={failed ? styles.mapHidden : styles.map}
          role="application"
          aria-label="Site location map"
        />
      </div>
    </div>
  );
}
