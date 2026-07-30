// ============================================================================
// LocationPicker - the map surface behind AddressField's map mode: a draggable
// pin and nothing else. The address text, the geocoding and the confirm/cancel
// of a location all belong to AddressField, so this file only has to answer
// "where is the pin".
//
// Addresses geocode to the centre of a street or postcode, which is rarely the
// gate an assessor needs to arrive at, so the pin can be placed exactly. It is
// a controlled component: every pin movement leaves through onChange and comes
// back as `value`, which is what lets the caller reverse-geocode the point and
// keep the address in step with it.
//
// A map is a pointing device, so it carries its own keyboard path: the arrow
// keys nudge the pin (Shift for a bigger step) and Enter drops one at the
// centre of the view. Mapbox's own keyboard handling is off so those keys move
// the PIN rather than panning under it.
//
// mapbox-gl is loaded with a dynamic import so it never enters the main bundle
// (it is far larger than the console itself) and never executes during the
// pre-render pass, which has no DOM. A blank token renders nothing at all and a
// failed load says so, exactly as AddressSearch degrades to a plain input.
// ============================================================================

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';
import { webConfig } from '../../config/env';
import type { GeoPoint } from '../../types';
import { toGeo } from './geocode';
import styles from './LocationPicker.module.css';

export interface LocationPickerProps {
  /** The pinned point, or null when nothing has been pinned yet. */
  value: GeoPoint | null;
  /** Fired on every pin movement: map click, drag, or keyboard nudge. */
  onChange: (geo: GeoPoint) => void;
  /** Told once when the map cannot be shown, so the caller can fall back to
   *  plain text entry and say why the map button is unavailable. */
  onUnavailable?: () => void;
  /** Id of the instruction text, so the map announces how to drive it. */
  describedBy?: string;
  disabled?: boolean;
}

/** Roughly the whole of Great Britain, used until we have a point to show. */
const UK_CENTRE: [number, number] = [-2.5, 54.0];
const UK_ZOOM = 4.6;
/** Close enough to distinguish one entrance from the next. */
const PINNED_ZOOM = 17;
/** An address or postcode pick lands near, not on, the target. */
const SEARCH_ZOOM = 16;
/** Nudge steps in screen pixels, so a step means the same thing at any zoom:
 *  a fine correction, and a coarse one for crossing a car park. */
const NUDGE_PX = 12;
const NUDGE_PX_COARSE = 60;

export function LocationPicker({
  value,
  onChange,
  onUnavailable,
  describedBy,
  disabled = false,
}: LocationPickerProps) {
  const token = webConfig.mapboxAccessToken.trim();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<MapboxMarker | null>(null);
  const [failed, setFailed] = useState(false);

  // Held in refs so the map is built exactly once: rebuilding it whenever the
  // pin moves would flicker and lose the user's zoom.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Read once the map chunk has loaded rather than snapshotted at mount: the
  // caller may geocode the typed address while the chunk is still downloading.
  const valueRef = useRef(value);
  valueRef.current = value;
  // A pin being dragged is already under the cursor; echoing the controlled
  // value back onto it mid-gesture fights the drag.
  const draggingRef = useRef(false);
  // Whether the incoming value is the pin we just moved ourselves. A pin the
  // user placed stays where they are looking; a point that arrived from
  // OUTSIDE (a picked address) is somewhere else entirely and must be flown to.
  const selfMovedRef = useRef(false);

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
        // Off so the arrow keys move the pin instead of panning the map from
        // under it; see the keyboard handler below.
        keyboard: false,
        attributionControl: true,
      });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }));

      const place = (geo: GeoPoint) => {
        if (!markerRef.current) {
          const marker = new mapboxgl.Marker({ draggable: !disabledRef.current, color: '#c0392b' })
            .setLngLat([geo.lng, geo.lat])
            .addTo(map);
          marker.on('dragstart', () => {
            draggingRef.current = true;
          });
          // Report during the drag, not only at the end, so the coordinates
          // readout tracks the pin as a live position.
          marker.on('drag', () => {
            selfMovedRef.current = true;
            onChangeRef.current(toGeo(marker.getLngLat()));
          });
          marker.on('dragend', () => {
            draggingRef.current = false;
            selfMovedRef.current = true;
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
        selfMovedRef.current = true;
        place(geo);
        onChangeRef.current(geo);
      });
    };

    void build().catch((error: unknown) => {
      // Losing the map must never lose the form: the address text still works,
      // so we explain the gap rather than throwing it at the user.
      console.warn('[Safentia] map picker unavailable', error);
      if (!cancelled) {
        setFailed(true);
        onUnavailableRef.current?.();
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

  // Keep the pin in step with the controlled value, so a point that arrives
  // from the address search lands on the map just as a dragged pin reports out.
  useEffect(() => {
    const map = mapRef.current;
    const selfMoved = selfMovedRef.current;
    selfMovedRef.current = false;
    if (!map || draggingRef.current) {
      return;
    }
    if (!value) {
      // No location means no pin; the next placement builds a fresh marker.
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    placeRef.current(value);
    if (selfMoved) {
      // The user put it there. Only chase it once it has left the view, or a
      // small correction would yank the map away from what they are looking at.
      if (!map.getBounds()?.contains([value.lng, value.lat])) {
        map.easeTo({ center: [value.lng, value.lat] });
      }
      return;
    }
    map.flyTo({
      center: [value.lng, value.lat],
      zoom: Math.max(map.getZoom(), SEARCH_ZOOM),
    });
  }, [value]);

  useEffect(() => {
    markerRef.current?.setDraggable(!disabled);
  }, [disabled]);

  /** The keyboard path onto the map: arrows nudge the pin, Shift widens the
   *  step, Enter drops a pin at the centre when there is not one yet. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const map = mapRef.current;
    if (!map || disabled) {
      return;
    }
    const current = valueRef.current;
    if (event.key === 'Enter' || event.key === ' ') {
      if (current) {
        return;
      }
      event.preventDefault();
      const geo = toGeo(map.getCenter());
      selfMovedRef.current = true;
      placeRef.current(geo);
      onChange(geo);
      return;
    }
    const step = event.shiftKey ? NUDGE_PX_COARSE : NUDGE_PX;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowUp') dy = -step;
    else if (event.key === 'ArrowDown') dy = step;
    else if (event.key === 'ArrowLeft') dx = -step;
    else if (event.key === 'ArrowRight') dx = step;
    else return;
    event.preventDefault();
    if (!current) {
      // Nothing to nudge yet: the first key press places the pin.
      const geo = toGeo(map.getCenter());
      selfMovedRef.current = true;
      placeRef.current(geo);
      onChange(geo);
      return;
    }
    const point = map.project([current.lng, current.lat]);
    const geo = toGeo(map.unproject([point.x + dx, point.y + dy]));
    selfMovedRef.current = true;
    placeRef.current(geo);
    onChange(geo);
  };

  // Without a token there is no map to offer; the caller hides its map button.
  if (!token) {
    return null;
  }

  return (
    <div className={styles.frame}>
      {failed && (
        <p className={styles.notice}>
          The map could not be loaded. Type the address instead — it is saved
          either way.
        </p>
      )}
      {/* Kept mounted even after a failure: the container ref must stay stable
          for the cleanup that follows. */}
      <div
        ref={containerRef}
        className={failed ? styles.mapHidden : styles.map}
        role="application"
        aria-label="Location map"
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        tabIndex={failed ? -1 : 0}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
