// ============================================================================
// ThemeToggle - a two-state switch between light and dark.
//
// It reports the state it is IN (aria-pressed) rather than the action it will
// take, and its accessible name says what pressing it does. Icon-only controls
// that lie about their state are a routine screen-reader failure.
//
// The icons are inline SVG. There is no icon font and no icon package: two paths
// do not justify either, and both would delay first paint.
// ============================================================================

import { useTheme } from '../design/ThemeProvider';
import styles from './ThemeToggle.module.css';

export function ThemeToggle() {
  const { scheme, toggle } = useTheme();
  const isDark = scheme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  // The visible tooltip is the stylesheet's ::after reading data-tooltip (not
  // a native title: the browser positions those wherever it likes, which sat
  // badly against the side rail). The accessible name stays on aria-label.
  return (
    <button
      type="button"
      onClick={toggle}
      className={styles.toggle}
      aria-pressed={isDark}
      aria-label={label}
      data-tooltip={label}
    >
      {isDark ? (
        // Sun: shown while dark is active, because pressing returns to light.
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle className={styles.solid} cx="12" cy="12" r="4.2" />
          <g className={styles.stroked} strokeLinecap="round">
            <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" />
            <path d="M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
          </g>
        </svg>
      ) : (
        // Moon.
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            className={styles.solid}
            d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"
          />
        </svg>
      )}
    </button>
  );
}
