// ============================================================================
// AssessmentMock - a stylised assessment checklist as the field app draws it.
// Sits inside a PhoneFrame (which is aria-hidden), so nothing here needs its
// own accessible naming. RAG surfaces appear only on the severity chips, where
// they mean risk.
// ============================================================================

import styles from './AssessmentMock.module.css';

export function AssessmentMock() {
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <span className={styles.building}>Harbour Point, Block B</span>
        <span className={styles.stage}>Assessment in progress</span>
      </header>

      <div className={styles.progress}>
        <span className={styles.progressFill} />
        <span className={styles.progressLabel}>Section 4 of 7</span>
      </div>

      <ul className={styles.questions}>
        <li className={styles.question}>
          <p className={styles.prompt}>Are escape routes kept clear of storage and obstruction?</p>
          <div className={styles.chips}>
            <span className={styles.answer}>No</span>
            <span className={`${styles.severity} ${styles.high}`}>High</span>
            <span className={styles.flag}>Life Protection</span>
          </div>
          <p className={styles.meta}>Facilities manager, due 21 Aug</p>
        </li>

        <li className={styles.question}>
          <p className={styles.prompt}>Is the fire alarm system tested weekly?</p>
          <div className={styles.chips}>
            <span className={styles.answer}>Yes</span>
            <span className={`${styles.severity} ${styles.ok}`}>Satisfactory</span>
          </div>
        </li>

        <li className={styles.question}>
          <div className={styles.photoRow}>
            <span className={styles.photo}>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="6" width="18" height="14" rx="2.5" />
                <circle cx="12" cy="13" r="3.5" />
                <path d="M9 6l1.2-2h3.6L15 6" />
              </svg>
            </span>
            <div>
              <p className={styles.photoTitle}>Riser cupboard, level 2</p>
              <p className={styles.meta}>Pinned to floor plan</p>
            </div>
          </div>
        </li>
      </ul>

      <footer className={styles.footer}>
        <span className={styles.syncDot} />
        Offline, syncs automatically
      </footer>
    </div>
  );
}
