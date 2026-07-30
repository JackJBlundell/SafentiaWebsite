// ============================================================================
// useImageFailed - "did this image actually load?", so a broken one can fall
// back to something designed rather than a browser's broken-image icon.
//
// An organisation's logo is REMOTE DATA pointing at an object we do not control
// the lifetime of: it can be deleted from Storage, have its token rotated, or
// have been saved as a URL that never resolved. The <img> then renders the
// browser's broken-image glyph inside our brand mark, which looks like the
// product is broken rather than the data.
//
// Keyed on the SRC rather than a plain boolean: a profile that gets a corrected
// logo re-renders with a new url, which no longer matches the failed one, so the
// image is retried automatically. A boolean would latch and keep showing the
// fallback for a logo that had since been fixed - and clearing it would need an
// effect, which is a worse trade than one string comparison.
// ============================================================================

import { useState } from 'react';

export interface ImageFailure {
  /** True when THIS src has failed to load. False for a fresh or changed src. */
  failed: boolean;
  /** Pass to the <img>'s onError. */
  onError: () => void;
}

export function useImageFailed(src: string | undefined): ImageFailure {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return {
    failed: Boolean(src) && failedSrc === src,
    onError: () => setFailedSrc(src ?? null),
  };
}
