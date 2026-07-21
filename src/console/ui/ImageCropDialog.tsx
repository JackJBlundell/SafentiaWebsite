// ============================================================================
// ImageCropDialog - a reusable modal square cropper, drawn with the plain 2D
// canvas (no library).
//
// The caller hands it an image Blob; the person drags (pointer events, so mouse
// and touch behave identically) and zooms (a labelled slider) to place a fixed
// SQUARE crop, then "Use this logo" renders that square to an offscreen canvas
// and resolves with a PNG Blob at `outputSize`. Cancel (or Escape) resolves
// null. Keyboard: the stage is focusable; arrow keys nudge the image and
// plus/minus zoom, so the crop is fully operable without a pointer.
//
// The maths is one rectangle: the image is drawn at `offset` (stage
// coordinates, top-left) scaled by baseScale * zoom, where baseScale makes the
// image's SHORTER side exactly fill the crop square at zoom 1. The offset is
// clamped after every move and zoom so the square is always fully covered -
// there is no way to produce a crop with blank edges.
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

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const NUDGE = 8; // arrow-key step, stage px
const ZOOM_STEP = 0.1;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface Offset {
  x: number;
  y: number;
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
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
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
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => setImg(image);
    image.onerror = () =>
      setError('Could not read that image. Please choose a different file.');
    image.src = url;
    return () => {
      // Neutralise the handlers so a stale decode from a superseded file can
      // never win the race against the current one.
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  /** Zoom 1 fits the image's shorter side exactly to the crop square, so the
   *  square is coverable at every zoom the slider allows. */
  const baseScale = img ? CROP / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = baseScale * zoom;
  const drawnW = img ? img.naturalWidth * scale : 0;
  const drawnH = img ? img.naturalHeight * scale : 0;

  /** Keep the crop square fully inside the drawn image: the image's top-left
   *  may be at most at the square's top-left, and its bottom-right at least at
   *  the square's bottom-right. */
  const clampOffset = useCallback(
    (next: Offset, w: number, h: number): Offset => ({
      x: clamp(next.x, MARGIN + CROP - w, MARGIN),
      y: clamp(next.y, MARGIN + CROP - h, MARGIN),
    }),
    [],
  );

  // Centre the image over the crop square once it has decoded.
  useEffect(() => {
    if (!img) {
      return;
    }
    const w = img.naturalWidth * (CROP / Math.min(img.naturalWidth, img.naturalHeight));
    const h = img.naturalHeight * (CROP / Math.min(img.naturalWidth, img.naturalHeight));
    setZoom(MIN_ZOOM);
    setOffset({ x: MARGIN + (CROP - w) / 2, y: MARGIN + (CROP - h) / 2 });
  }, [img]);

  /** Change zoom keeping the point at the centre of the crop square fixed, so
   *  zooming feels anchored rather than drifting towards a corner. */
  const applyZoom = (nextZoom: number) => {
    if (!img) {
      return;
    }
    const clamped = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const ratio = clamped / zoom;
    const centre = MARGIN + CROP / 2;
    const nextW = img.naturalWidth * baseScale * clamped;
    const nextH = img.naturalHeight * baseScale * clamped;
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

  // --- draw ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return; // no 2D context (test environments); the export path reports it
    }
    ctx.clearRect(0, 0, STAGE, STAGE);
    ctx.drawImage(img, offset.x, offset.y, drawnW, drawnH);
    // Dim everything outside the crop square, then edge the square itself.
    ctx.fillStyle = 'rgba(10, 14, 18, 0.55)';
    ctx.fillRect(0, 0, STAGE, MARGIN); // top band
    ctx.fillRect(0, MARGIN + CROP, STAGE, MARGIN); // bottom band
    ctx.fillRect(0, MARGIN, MARGIN, CROP); // left band
    ctx.fillRect(MARGIN + CROP, MARGIN, MARGIN, CROP); // right band
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN + 0.5, MARGIN + 0.5, CROP - 1, CROP - 1);
  }, [img, offset, drawnW, drawnH]);

  // --- pointer dragging -------------------------------------------------------
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!img || busy) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const last = dragRef.current;
    if (!last || !img) {
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
    if (!img || busy) {
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
    if (!img || busy) {
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
    const f = outputSize / CROP;
    ctx.drawImage(img, (offset.x - MARGIN) * f, (offset.y - MARGIN) * f, drawnW * f, drawnH * f);
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
          Drag the image to position it, and zoom to fill the square. The square
          is what will be kept.
        </p>

        <div className={styles.stageWrap}>
          {img ? (
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="image-crop-zoom">
            Zoom
          </label>
          <input
            id="image-crop-zoom"
            className={styles.slider}
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!img || busy}
            onChange={(event) => applyZoom(Number(event.target.value))}
          />
        </div>

        {error && <ErrorNotice message={error} />}

        <div className={styles.actions}>
          <Button type="button" onClick={confirm} disabled={!img || busy}>
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
