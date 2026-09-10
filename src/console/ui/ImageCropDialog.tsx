// ============================================================================
// ImageCropDialog - a reusable modal square cropper, drawn with the plain 2D
// canvas (no library).
//
// The caller hands it an image Blob; the person drags (pointer events, so mouse
// and touch behave identically) and zooms (a labelled slider, plus explicit
// "Fit whole image" / "Fill square" buttons) to place a fixed SQUARE crop, then
// "Use this logo" renders that square to an offscreen canvas and resolves with a
// PNG Blob at `outputSize`. Cancel (or Escape) resolves null. Keyboard: the
// stage is focusable; arrow keys nudge the image and plus/minus zoom, so the
// crop is fully operable without a pointer.
//
// The maths is one rectangle: the image is drawn at `offset` (stage
// coordinates, top-left) scaled by baseScale * zoom, where baseScale makes the
// image's SHORTER side exactly fill the crop square - so zoom 1 is "fill the
// square". Zoom may go BELOW 1, down to the per-image `fitZoom`
// (shorterSide / longerSide), which is exactly the zoom at which the LONGER
// side fits the square and the whole image is visible. A wordmark logo is only
// showable whole below zoom 1, which is why the minimum is per-image rather
// than a constant.
//
// Because of that the drawn image can be SMALLER than the crop square on one or
// both axes, so `clampOffset` has two regimes, per axis:
//   * drawn >= CROP (covering): the image's leading edge may sit at most at the
//     square's leading edge and its trailing edge at least at the square's -
//     the square stays fully covered, no blank edges.
//   * drawn <  CROP (fitting):  the range inverts, and the image is kept INSIDE
//     the square instead - free positioning, with transparent padding around it.
// Written as one axis function so a single expression handles both, and a
// square-ish image (where the old inverted clamp collapsed to a point and every
// drag was silently a no-op) still moves wherever there is room to move.
//
// Robustness: an SVG (or any vector) can report naturalWidth/naturalHeight of 0.
// That used to make baseScale Infinity and every derived offset NaN, so the
// canvas drew nothing and the whole dialog felt frozen. `resolveIntrinsicSize`
// substitutes a sensible box (recovering the aspect ratio from the SVG's own
// viewBox where it can, otherwise a 512 square), and nothing non-finite is ever
// allowed into state.
//
// The exported canvas is NEVER filled: it stays transparent, so a transparent
// PNG logo keeps its transparency and a fitted (zoom < 1) logo is padded with
// transparency rather than boxed in white or black.
//
// Accessibility skeleton mirrors CreateOrganisationDialog: focus moves in on
// open, Tab is trapped (parking on the dialog itself when everything is
// disabled while busy), Escape closes, and focus returns to the opener.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorNotice } from './Page';
import styles from './ImageCropDialog.module.css';

const FOCUSABLE = 'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

/** Stage geometry, in canvas pixels. The crop square sits inset within the
 *  stage so the dimmed surround is visible, making the crop boundary obvious. */
const STAGE = 360;
const MARGIN = 24;
const CROP = STAGE - MARGIN * 2;

/** Zoom 1 = the image's shorter side exactly fills the crop square. The lower
 *  bound is per image (see `fitZoom`), never a constant. */
const FILL_ZOOM = 1;
const MAX_ZOOM = 4;
const NUDGE = 8; // arrow-key step, stage px
const ZOOM_STEP = 0.1;

/** The box used for an image that reports no intrinsic size of its own. 512 is
 *  the default output size, so a vector is rastered at roughly 1:1. */
const FALLBACK_INTRINSIC = 512;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface Offset {
  x: number;
  y: number;
}

/** One axis of the clamp. Covering (drawn >= CROP): the image must span the
 *  square, so the offset sits between "trailing edges flush" and "leading edges
 *  flush". Fitting (drawn < CROP): that range inverts, and the same two bounds -
 *  taken the other way round - keep the image INSIDE the square, which is what
 *  makes a fitted or square-ish image draggable at all. Nothing non-finite ever
 *  escapes: an unusable input falls back to centred. */
function clampAxis(value: number, drawn: number): number {
  const leadingFlush = MARGIN; // image's left/top edge on the square's
  const trailingFlush = MARGIN + CROP - drawn; // image's right/bottom on the square's
  if (!Number.isFinite(value) || !Number.isFinite(drawn)) {
    return Number.isFinite(drawn) ? MARGIN + (CROP - drawn) / 2 : MARGIN;
  }
  return drawn >= CROP
    ? clamp(value, trailingFlush, leadingFlush)
    : clamp(value, leadingFlush, trailingFlush);
}

/** Keep the crop square and the drawn image in the right relationship on both
 *  axes (see clampAxis). Depends only on the stage constants, so it lives at
 *  module scope and is stable across renders. */
function clampOffset(next: Offset, w: number, h: number): Offset {
  return { x: clampAxis(next.x, w), y: clampAxis(next.y, h) };
}

/** The offset that centres a drawn image of this size on the crop square. Valid
 *  in both clamp regimes, so it needs no further clamping. */
function centredOffset(w: number, h: number): Offset {
  return { x: MARGIN + (CROP - w) / 2, y: MARGIN + (CROP - h) / 2 };
}

/** A decoded image together with the intrinsic size the geometry may rely on:
 *  always finite and positive, whatever the file claimed. */
interface Source {
  img: HTMLImageElement;
  width: number;
  height: number;
}

/** Pull an aspect ratio (width / height) out of an SVG's own markup, for the
 *  browsers that report naturalWidth 0 for a vector with no width/height
 *  attributes. The viewBox is the reliable signal; explicit width/height
 *  attributes are the fallback. Returns null when nothing usable is found. */
async function svgAspectRatio(file: Blob): Promise<number | null> {
  if (file.type !== 'image/svg+xml') {
    return null;
  }
  try {
    const head = (await file.text()).slice(0, 4096);
    const viewBox =
      /viewBox\s*=\s*["']\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)/.exec(
        head,
      );
    if (viewBox) {
      const w = Number(viewBox[1]);
      const h = Number(viewBox[2]);
      if (w > 0 && h > 0) {
        return w / h;
      }
    }
    const width = /\bwidth\s*=\s*["']\s*([\d.]+)/.exec(head);
    const height = /\bheight\s*=\s*["']\s*([\d.]+)/.exec(head);
    if (width && height) {
      const w = Number(width[1]);
      const h = Number(height[1]);
      if (w > 0 && h > 0) {
        return w / h;
      }
    }
  } catch {
    // Unreadable markup is not an error worth showing: fall through to the
    // square fallback, which still gives a usable, draggable crop.
  }
  return null;
}

/** The intrinsic size the maths will use. A raster image reports its own; a
 *  vector that reports nothing gets a 512-long box in its own aspect ratio
 *  where that can be recovered, and a 512 square otherwise. Guarantees finite,
 *  positive dimensions, which is what keeps baseScale finite. */
async function resolveIntrinsicSize(
  file: Blob,
  image: HTMLImageElement,
): Promise<{ width: number; height: number }> {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  const ratio = await svgAspectRatio(file);
  if (ratio !== null && Number.isFinite(ratio) && ratio > 0) {
    return ratio >= 1
      ? { width: FALLBACK_INTRINSIC, height: FALLBACK_INTRINSIC / ratio }
      : { width: FALLBACK_INTRINSIC * ratio, height: FALLBACK_INTRINSIC };
  }
  return { width: FALLBACK_INTRINSIC, height: FALLBACK_INTRINSIC };
}

export interface ImageCropDialogProps {
  /** The picked image to crop. */
  file: Blob;
  /** Dialog heading. */
  title?: string;
  /** The confirm button's label. */
  confirmLabel?: string;
  /** Side length of the square PNG produced, in pixels. */
  outputSize?: number;
  /** Called exactly once: with the cropped PNG Blob, or null on cancel. */
  onDone: (blob: Blob | null) => void;
}

export function ImageCropDialog({
  file,
  title = 'Position your logo',
  confirmLabel = 'Use this logo',
  outputSize = 512,
  onDone,
}: ImageCropDialogProps) {
  const [source, setSource] = useState<Source | null>(null);
  const [zoom, setZoom] = useState(FILL_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: MARGIN, y: MARGIN });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  /** Last pointer position while dragging, or null when not dragging. */
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const busy = exporting;

  const cancel = useCallback(() => {
    if (exporting) {
      return;
    }
    onDone(null);
  }, [exporting, onDone]);

  // --- decode the blob into an image ---------------------------------------
  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      // Resolving the intrinsic size may need to read the blob (vectors), so it
      // is async; the cancelled flag stops a superseded file's decode landing.
      void resolveIntrinsicSize(file, image).then((size) => {
        if (!cancelled) {
          setSource({ img: image, width: size.width, height: size.height });
        }
      });
    };
    image.onerror = () => {
      if (!cancelled) {
        setError('Could not read that image. Please choose a different file.');
      }
    };
    image.src = url;
    return () => {
      // Neutralise the handlers so a stale decode from a superseded file can
      // never win the race against the current one.
      cancelled = true;
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // --- per-image geometry ---------------------------------------------------
  /** baseScale makes the SHORTER side exactly fill the crop square, so zoom 1
   *  fills; fitZoom (shorter / longer) is the zoom at which the LONGER side
   *  fits it, so the whole image shows. fitZoom <= 1 always, and equals 1 for a
   *  square image, where filling and fitting are the same thing. */
  const shorterSide = source ? Math.min(source.width, source.height) : 1;
  const longerSide = source ? Math.max(source.width, source.height) : 1;
  const baseScale = source ? CROP / shorterSide : 1;
  const fitZoom = source ? shorterSide / longerSide : FILL_ZOOM;
  const minZoom = Math.min(fitZoom, FILL_ZOOM);
  const scale = baseScale * zoom;
  const drawnW = source ? source.width * scale : 0;
  const drawnH = source ? source.height * scale : 0;

  // Fill the square and centre the image once it has decoded: filling is the
  // right default for a photo, and "Fit whole image" is one button away for a
  // wide logo.
  useEffect(() => {
    if (!source) {
      return;
    }
    const base = CROP / Math.min(source.width, source.height);
    setZoom(FILL_ZOOM);
    setOffset(centredOffset(source.width * base, source.height * base));
  }, [source]);

  /** Change zoom keeping the point at the centre of the crop square fixed, so
   *  zooming feels anchored rather than drifting towards a corner. */
  const applyZoom = (nextZoom: number) => {
    if (!source) {
      return;
    }
    const clamped = clamp(nextZoom, minZoom, MAX_ZOOM);
    const ratio = clamped / zoom;
    const centre = MARGIN + CROP / 2;
    const nextW = source.width * baseScale * clamped;
    const nextH = source.height * baseScale * clamped;
    setZoom(clamped);
    setOffset(
      clampOffset(
        {
          x: centre - (centre - offset.x) * ratio,
          y: centre - (centre - offset.y) * ratio,
        },
        nextW,
        nextH,
      ),
    );
  };

  /** Jump to a named zoom (the Fit / Fill buttons) and re-centre, so the result
   *  is the same predictable framing however the image was positioned before. */
  const showAt = (nextZoom: number) => {
    if (!source) {
      return;
    }
    const clamped = clamp(nextZoom, minZoom, MAX_ZOOM);
    setZoom(clamped);
    setOffset(
      centredOffset(
        source.width * baseScale * clamped,
        source.height * baseScale * clamped,
      ),
    );
  };

  // --- draw ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return; // no 2D context (test environments); the export path reports it
    }
    ctx.clearRect(0, 0, STAGE, STAGE);
    ctx.drawImage(source.img, offset.x, offset.y, drawnW, drawnH);
    // Dim everything outside the crop square, then edge the square itself. At
    // zoom < 1 the square is only partly covered; the uncovered part shows the
    // stage's own backdrop, which is the honest preview of the transparent
    // padding the exported PNG will carry.
    ctx.fillStyle = 'rgba(10, 14, 18, 0.55)';
    ctx.fillRect(0, 0, STAGE, MARGIN); // top band
    ctx.fillRect(0, MARGIN + CROP, STAGE, MARGIN); // bottom band
    ctx.fillRect(0, MARGIN, MARGIN, CROP); // left band
    ctx.fillRect(MARGIN + CROP, MARGIN, MARGIN, CROP); // right band
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN + 0.5, MARGIN + 0.5, CROP - 1, CROP - 1);
  }, [source, offset, drawnW, drawnH]);

  // --- pointer dragging -------------------------------------------------------
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!source || busy) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const last = dragRef.current;
    if (!last || !source) {
      return;
    }
    // The canvas may render smaller than its internal STAGE pixels; convert
    // the pointer delta into stage coordinates so the drag tracks the finger.
    const rect = event.currentTarget.getBoundingClientRect();
    const factor = rect.width > 0 ? STAGE / rect.width : 1;
    const dx = (event.clientX - last.x) * factor;
    const dy = (event.clientY - last.y) * factor;
    dragRef.current = { x: event.clientX, y: event.clientY };
    setOffset((prev) => clampOffset({ x: prev.x + dx, y: prev.y + dy }, drawnW, drawnH));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  // --- keyboard nudging --------------------------------------------------------
  const onStageKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!source || busy) {
      return;
    }
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case 'ArrowLeft':
        dx = -NUDGE;
        break;
      case 'ArrowRight':
        dx = NUDGE;
        break;
      case 'ArrowUp':
        dy = -NUDGE;
        break;
      case 'ArrowDown':
        dy = NUDGE;
        break;
      case '+':
      case '=':
        event.preventDefault();
        applyZoom(zoom + ZOOM_STEP);
        return;
      case '-':
      case '_':
        event.preventDefault();
        applyZoom(zoom - ZOOM_STEP);
        return;
      default:
        return;
    }
    event.preventDefault();
    setOffset((prev) => clampOffset({ x: prev.x + dx, y: prev.y + dy }, drawnW, drawnH));
  };

  // --- export -------------------------------------------------------------------
  const confirm = () => {
    if (!source || busy) {
      return;
    }
    const out = document.createElement('canvas');
    out.width = outputSize;
    out.height = outputSize;
    const ctx = out.getContext('2d');
    if (!ctx) {
      setError('Could not prepare the cropped image. Please try again.');
      return;
    }
    // Map the crop square onto the output canvas: same drawing, rescaled by
    // outputSize / CROP and translated so the square's corner becomes (0, 0).
    // The canvas is deliberately NOT filled first, so anything the drawing does
    // not cover - transparency in the source, and the padding around a fitted
    // logo at zoom < 1 - stays transparent instead of becoming a white box.
    const f = outputSize / CROP;
    ctx.drawImage(
      source.img,
      (offset.x - MARGIN) * f,
      (offset.y - MARGIN) * f,
      drawnW * f,
      drawnH * f,
    );
    setExporting(true);
    out.toBlob((blob) => {
      if (blob) {
        onDone(blob);
      } else {
        setExporting(false);
        setError('Could not prepare the cropped image. Please try again.');
      }
    }, 'image/png');
  };

  // --- modal a11y skeleton (as CreateOrganisationDialog) -------------------------
  // Focus in on open; on unmount, return focus to the opener if it is still in
  // the document, otherwise land on the page's first heading.
  useEffect(() => {
    openerRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
        return;
      }
      const heading = document.querySelector<HTMLElement>('h1, h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
    };
  }, []);

  // Escape cancels; Tab wraps within the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) {
        // Every control disabled while busy: park focus on the dialog itself
        // (tabIndex={-1}) so Tab cannot escape the modal to the page behind.
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [cancel]);

  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-crop-title"
        className={styles.dialog}
        tabIndex={-1}
      >
        <h2 id="image-crop-title" className={styles.title}>
          {title}
        </h2>
        <p className={styles.copy}>
          Drag the image to position it, and zoom to frame it. Zoom in to fill
          the square, or choose Fit whole image to keep the whole of a wide logo,
          with transparent space around it. The square is what will be kept.
        </p>

        <div className={styles.stageWrap}>
          {source ? (
            <canvas
              ref={canvasRef}
              width={STAGE}
              height={STAGE}
              className={styles.stage}
              tabIndex={0}
              aria-label="Crop position. Use the arrow keys to move the image, and plus or minus to zoom."
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onStageKeyDown}
            />
          ) : (
            !error && (
              <p role="status" className={styles.loading}>
                Loading image
              </p>
            )
          )}
        </div>

        {/* The two framings people actually want, as buttons: dragging alone
            never reveals that zooming out below "fill" is possible. */}
        <div className={styles.modes}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => showAt(fitZoom)}
            disabled={!source || busy}
          >
            Fit whole image
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => showAt(FILL_ZOOM)}
            disabled={!source || busy}
          >
            Fill square
          </Button>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="image-crop-zoom">
            Zoom
          </label>
          <input
            id="image-crop-zoom"
            className={styles.slider}
            type="range"
            /* The floor is per image: the zoom at which the whole image fits. */
            min={minZoom}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!source || busy}
            onChange={(event) => applyZoom(Number(event.target.value))}
          />
        </div>

        {error && <ErrorNotice message={error} />}

        <div className={styles.actions}>
          <Button type="button" onClick={confirm} disabled={!source || busy}>
            {exporting ? 'Preparing' : confirmLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
