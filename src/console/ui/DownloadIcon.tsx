// ============================================================================
// DownloadIcon - the one download glyph, shared by every download affordance in
// the console.
//
// In a table the download is the same affordance on every row, so "Download PDF"
// repeated down a column is pure repetition taking a column's width - and the
// thing that actually varies (which building's report) was never in the visible
// words anyway. The icon carries the affordance; the varying part belongs in the
// control's accessible name, which is where it can say MORE than the label ever
// did.
//
// PURELY DECORATIVE HERE: aria-hidden, with no title of its own. The control
// that wraps it owns the name - an aria-label on the anchor or button - so the
// icon must not add a second, competing one. A download control that renders
// this and gives itself no accessible name is a bug: it would announce as
// "link", and this is the one place that cannot be fixed from.
// ============================================================================

export function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 18 18"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Arrow into a tray: the shape people read as "download" without a label. */}
      <path d="M9 3v8" />
      <path d="M5.5 8 9 11.5 12.5 8" />
      <path d="M3.5 13.5h11" />
    </svg>
  );
}
