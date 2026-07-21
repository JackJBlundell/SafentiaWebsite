// ============================================================================
// ReportMock - a stylised page of the released PDF report, as the server
// generates it: organisation branding, the proportional risk profile, the
// severity-ordered action plan and the three-way sign-off block. Sits inside a
// BrowserFrame (aria-hidden).
// ============================================================================

import { RagMeter } from './RagMeter';
import styles from './ReportMock.module.css';

const ACTIONS = [
  { severity: 'High', tone: 'high', text: 'Remove storage from the level 2 escape route' },
  { severity: 'Medium', tone: 'medium', text: 'Fit a self-closer to the plant room door' },
  { severity: 'Low', tone: 'low', text: 'Replace the faded fire action notice in reception' },
] as const;

export function ReportMock() {
  return (
    <div className={styles.report}>
      <header className={styles.head}>
        <span className={styles.orgMark} />
        <div>
          <p className={styles.title}>Fire risk assessment report</p>
          <p className={styles.subtitle}>Harbour Point, Block B. Structured in line with PAS 79-1:2020.</p>
        </div>
      </header>

      <RagMeter green={24} amber={6} red={2} caption="Risk profile across 32 assessed questions" />

      <div className={styles.plan}>
        <p className={styles.planHeading}>Action plan, ordered by severity</p>
        <ul className={styles.planList}>
          {ACTIONS.map((action) => (
            <li key={action.text} className={styles.planRow}>
              <span className={`${styles.severity} ${styles[action.tone]}`}>{action.severity}</span>
              <span className={styles.planText}>{action.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer className={styles.signoff}>
        {['Conducted by', 'Checked by', 'Validated by'].map((role) => (
          <div key={role} className={styles.signature}>
            <span className={styles.signatureRole}>{role}</span>
            <span className={styles.signatureLine} />
          </div>
        ))}
      </footer>
    </div>
  );
}
