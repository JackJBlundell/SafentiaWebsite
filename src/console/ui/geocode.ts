// ============================================================================
// Mapbox geocoding - the one place that knows the shape of a Mapbox response.
//
// Forward (text -> point) backs the address combobox; reverse (point -> text)
// is what keeps a dragged pin honest, because coordinates are DERIVED here and
// never typed: whichever end the person touches, the other is looked up rather
// than left to drift.
//
// Nothing throws. Geocoding is a convenience, never a gate, so a caller that
// loses it falls back to plain typing instead of putting a third party's outage
// in front of an assessor. The distinction the callers need is "no matches"
// (an empty array / null result) versus "the lookup failed" (null / undefined),
// so the two are returned differently rather than collapsed.
//
// This is the console's only third-party call besides Firebase / reCAPTCHA; the
// Privacy policy names it. Only the search text or the pinned point leaves the
// browser.
// ============================================================================

import type { GeoPoint } from '../../types';

/** What a resolved address is: the display text plus the point it names. */
export interface AddressSelection {
  address: string;
  geo: GeoPoint;
}

/** A geocoder match, with Mapbox's own id for React keys. */
export interface GeocodeMatch extends AddressSelection {
  id: string;
}

/** The fields we read from a Mapbox feature; the rest of the payload is
 *  ignored, so an upstream addition can never break the parse. */
interface MapboxFeature {
  id?: string;
  place_name?: string;
  center?: [number, number];
}

const BASE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
/** Great Britain only: every customer, site and building we hold is here, and
 *  the narrower search puts the right street at the top of the list. */
const COUNTRY = 'gb';

/** Six decimal places is about 0.1m - well past the precision of a dragged pin,
 *  and it keeps the stored value short and comparable. */
export function roundCoordinate(coordinate: number): number {
  return Math.round(coordinate * 1e6) / 1e6;
}

export function toGeo(lngLat: { lng: number; lat: number }): GeoPoint {
  return { lat: roundCoordinate(lngLat.lat), lng: roundCoordinate(lngLat.lng) };
}

/** Coordinates as the readouts show them: enough precision to identify a gate,
 *  short enough to read aloud. */
export function formatGeo(geo: GeoPoint): string {
  return `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`;
}

function parseFeatures(payload: unknown): GeocodeMatch[] {
  const features = (payload as { features?: MapboxFeature[] })?.features;
  if (!Array.isArray(features)) {
    return [];
  }
  const matches: GeocodeMatch[] = [];
  for (const feature of features) {
    if (
      typeof feature?.place_name === 'string' &&
      Array.isArray(feature.center) &&
      typeof feature.center[0] === 'number' &&
      typeof feature.center[1] === 'number'
    ) {
      matches.push({
        id: feature.id ?? `${feature.center[0]},${feature.center[1]}`,
        address: feature.place_name,
        // Mapbox centres are [lng, lat].
        geo: { lat: feature.center[1], lng: feature.center[0] },
      });
    }
  }
  return matches;
}

async function query(url: string, what: string): Promise<GeocodeMatch[] | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Geocoding failed: ${response.status}`);
    }
    return parseFeatures(await response.json());
  } catch (error) {
    // Silent to the caller, but never undiagnosable.
    console.warn(`[Safentia] ${what} unavailable`, error);
    return null;
  }
}

/**
 * Text -> matches. Returns an empty array when the geocoder simply knows of no
 * such place, and null when the lookup itself failed - the caller says "no
 * matches" for the first and stays quiet for the second.
 */
export function forwardGeocode(
  text: string,
  token: string,
  limit = 5,
): Promise<GeocodeMatch[] | null> {
  return query(
    `${BASE}/${encodeURIComponent(text)}.json?access_token=${encodeURIComponent(
      token,
    )}&country=${COUNTRY}&limit=${limit}&types=address,postcode,place`,
    'address search',
  );
}

/**
 * Point -> the address that names it, or null when there is none to be had.
 *
 * Only the ADDRESS of the result is ever used: the returned feature's own
 * centre is the middle of the matched street, which is not where the pin was
 * put. The pin's own coordinates remain the location.
 */
export async function reverseGeocode(
  geo: GeoPoint,
  token: string,
): Promise<string | null> {
  const matches = await query(
    `${BASE}/${geo.lng},${geo.lat}.json?access_token=${encodeURIComponent(
      token,
    )}&country=${COUNTRY}&limit=1&types=address,postcode,place`,
    'address lookup',
  );
  return matches?.[0]?.address ?? null;
}
