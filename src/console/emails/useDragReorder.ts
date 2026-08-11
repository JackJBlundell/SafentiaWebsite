// ============================================================================
// useDragReorder - hand-rolled pointer + keyboard reordering for a vertical
// list (the ScheduleTimeline precedent: pointer capture on the pressed
// element, no drag-and-drop library).
//
// The central trick: NOTHING moves in the DOM until the drop. While a drag is
// live the dragged item follows the pointer with translateY and every
// displaced sibling slides out of the way with its own transform, so React
// never reorders children mid-drag - which is what keeps a focused <input>
// inside a block focused (a DOM reorder would blur it and lose the caret).
// Only pointerup commits, through one onReorder(from, to) the owner applies to
// its state; the transforms are then dropped in the same render the list
// actually reorders, so nothing visually jumps.
//
// Geometry is SNAPSHOTTED at pointerdown (each item's offsetTop/offsetHeight):
// mid-drag the transforms make live layout reads meaningless, and a list of
// form cards does not change height while one of them is being dragged.
//
// The keyboard path is deliberately simpler: ArrowUp/ArrowDown on the handle
// commit a single-step onReorder immediately - no "grab" mode to learn - and
// every move (either path) updates `announcement` for the owner's
// visually-hidden role="status" region.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export interface DragReorderOptions {
  /** How many items the list currently renders. */
  count: number;
  /** Commit a move: the item at `from` ends up at index `to`. */
  onReorder: (from: number, to: number) => void;
  /** Names an item for aria-labels and announcements ("Paragraph block").
   *  Defaults to "Item {n}". */
  itemLabel?: (index: number) => string;
}

export interface DragState {
  /** Index the drag started from. */
  from: number;
  /** Slot the item would land in if dropped now. */
  over: number;
  /** Pointer travel in px, applied to the dragged item. */
  delta: number;
}

export interface DragReorderApi {
  /** Attach to the element whose DIRECT children are the list items, in
   *  order - the geometry snapshot reads them positionally. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Inline transform for item `i` while a drag is live; undefined when idle
   *  so idle renders carry no style at all. */
  getItemStyle: (index: number) => React.CSSProperties | undefined;
  /** Spread onto the drag handle of item `i`. */
  getHandleProps: (index: number) => {
    role: 'button';
    tabIndex: 0;
    'aria-label': string;
    style: React.CSSProperties;
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
  /** Live drag geometry, null when idle. Lets the owner add a "lifted" class
   *  (shadow, raised z-index) to the dragged item. */
  dragState: DragState | null;
  /** Latest reorder message for a visually-hidden role="status" region. */
  announcement: string;
}

/** Geometry captured at pointerdown; held in a ref so pointermove handlers
 *  never read stale React state. */
interface DragSession {
  pointerId: number;
  handle: HTMLElement;
  startY: number;
  from: number;
  /** offsetTop of every item at press time. */
  tops: number[];
  /** offsetHeight of every item at press time. */
  heights: number[];
  /** How far a displaced sibling slides: dragged height + the list gap. */
  shift: number;
  /** Latest target slot, mirrored here so pointerup commits from the ref -
   *  never from inside a state updater, whose double-invoke under StrictMode
   *  would apply the reorder twice. */
  over: number;
}

/** How long a displaced sibling takes to slide into its "make room" spot. */
const SHIFT_TRANSITION = 'transform 120ms ease';

export function useDragReorder({
  count,
  onReorder,
  itemLabel,
}: DragReorderOptions): DragReorderApi {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const label = useCallback(
    (index: number) => itemLabel?.(index) ?? `Item ${index + 1}`,
    [itemLabel],
  );

  const announceMove = useCallback(
    (index: number, to: number) => {
      setAnnouncement(`${label(index)} moved to position ${to + 1} of ${count}.`);
    },
    [label, count],
  );

  // Abort without committing: pointercancel, Escape, or the list changing
  // under the drag. Capture release is best-effort - the browser has already
  // released it on pointercancel.
  const abort = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      session.handle.releasePointerCapture(session.pointerId);
    } catch {
      /* already released */
    }
    sessionRef.current = null;
    setDrag(null);
  }, []);

  // Escape abandons the drag (standard drag-and-drop grammar). Window-level
  // because pointer capture does not route KEY events to the handle.
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') abort();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, abort]);

  // A block deleted or added mid-drag invalidates the geometry snapshot;
  // abandoning beats committing a move computed against a vanished layout.
  useEffect(() => {
    if (sessionRef.current && sessionRef.current.tops.length !== count) abort();
  }, [count, abort]);

  const onPointerDown = useCallback((index: number, event: React.PointerEvent<HTMLElement>) => {
    // Primary button only: a right-click or second touch is not a drag.
    if (!event.isPrimary || event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(container.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    if (items.length !== count || index >= count) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const tops = items.map((item) => item.offsetTop);
    const heights = items.map((item) => item.offsetHeight);
    // The gap between adjacent items, measured rather than assumed, so the
    // "make room" shift lands displaced siblings exactly where the dragged
    // item's slot was.
    const gap = count > 1 ? tops[1] - tops[0] - heights[0] : 0;
    sessionRef.current = {
      pointerId: event.pointerId,
      handle,
      startY: event.clientY,
      from: index,
      tops,
      heights,
      shift: heights[index] + gap,
      over: index,
    };
    setDrag({ from: index, over: index, delta: 0 });
  }, [count]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    const { from, tops, heights } = session;
    const delta = event.clientY - session.startY;
    // Target slot by midpoint crossing: the drag lands wherever the dragged
    // item's CENTRE has passed a neighbour's centre, walked outward from the
    // origin so the scan stops at the first uncrossed neighbour.
    const centre = tops[from] + heights[from] / 2 + delta;
    let over = from;
    for (let j = from - 1; j >= 0; j -= 1) {
      if (centre < tops[j] + heights[j] / 2) over = j;
      else break;
    }
    if (over === from) {
      for (let j = from + 1; j < tops.length; j += 1) {
        if (centre > tops[j] + heights[j] / 2) over = j;
        else break;
      }
    }
    session.over = over;
    setDrag({ from, over, delta });
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      const { from, over } = session;
      try {
        session.handle.releasePointerCapture(session.pointerId);
      } catch {
        /* already released */
      }
      sessionRef.current = null;
      setDrag(null);
      if (over !== from) {
        onReorder(from, over);
        announceMove(from, over);
      }
    },
    [onReorder, announceMove],
  );

  const onPointerCancel = useCallback(() => abort(), [abort]);

  const onKeyDown = useCallback(
    (index: number, event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const to = index + step;
      if (to < 0 || to >= count) return;
      onReorder(index, to);
      announceMove(index, to);
    },
    [count, onReorder, announceMove],
  );

  const getItemStyle = useCallback(
    (index: number): React.CSSProperties | undefined => {
      if (!drag) return undefined;
      const session = sessionRef.current;
      const shift = session?.shift ?? 0;
      const { from, over, delta } = drag;
      if (index === from) {
        // The dragged item tracks the pointer raw - a transition here would
        // make it lag the finger.
        return {
          transform: `translateY(${delta}px)`,
          transition: 'none',
          position: 'relative',
          zIndex: 2,
        };
      }
      if (from < over && index > from && index <= over) {
        return { transform: `translateY(${-shift}px)`, transition: SHIFT_TRANSITION };
      }
      if (over < from && index >= over && index < from) {
        return { transform: `translateY(${shift}px)`, transition: SHIFT_TRANSITION };
      }
      // Untouched items still get the transition, so one sliding BACK to rest
      // (the drag reversed direction) eases home instead of snapping.
      return { transition: SHIFT_TRANSITION };
    },
    [drag],
  );

  const getHandleProps = useCallback(
    (index: number) => ({
      role: 'button' as const,
      tabIndex: 0 as const,
      'aria-label': `Reorder ${label(index)}, position ${index + 1} of ${count}. Use the arrow keys to move it.`,
      // touch-action none, or mobile browsers claim the gesture for scrolling
      // before pointermove ever fires.
      style: { touchAction: 'none' } as React.CSSProperties,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => onPointerDown(index, event),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => onKeyDown(index, event),
    }),
    [label, count, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown],
  );

  return { containerRef, getItemStyle, getHandleProps, dragState: drag, announcement };
}
