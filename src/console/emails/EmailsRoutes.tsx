// ============================================================================
// EmailsRoutes - the mount point for the Emails area (org email templating,
// section 6b). The shell mounts this once at /app/emails/*; routing detail
// below that stays private to this directory.
//
// The whole area is admin ground: the send log's rule grants read to admin
// ONLY (a non-admin listener would be denied and retried uselessly), and
// authoring templates is an administrator task. The shell already hides the
// nav item from non-admins; the gate here covers the direct-URL case, calm
// rather than alarmed - nothing was breached, the page just is not theirs.
//
// Sub-nav tabs (the ActivityRoutes idiom): Sent (the send log, index),
// Templates (the org's authored copy), Email types (per-kind toggles and
// template assignment) and Compose (the manual send).
//
// The template screens are code-split behind React.lazy: the editor carries
// the block vocabulary and live preview, and the send log should not pay for
// either on first paint.
// ============================================================================

import { Suspense, lazy } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { useEntitlements } from '../billing/useEntitlements';
import { UpsellNotice } from '../billing/UpsellNotice';
import { EmptyState } from '../ui/Page';
import { LoadingNote } from '../customers/shared';
import { SentEmailsPage } from './SentEmailsPage';
import styles from './EmailsRoutes.module.css';

const EmailTemplatesPage = lazy(() => import('./EmailTemplatesPage'));
const EmailTemplateEditor = lazy(() => import('./EmailTemplateEditor'));
const EmailTypesPage = lazy(() => import('./EmailTypesPage'));
const ComposePage = lazy(() => import('./ComposePage'));

/** The area's tabs; further sections are added here alongside their `<Route>`
 *  entries below. */
const TABS = [
  { to: '/app/emails', label: 'Sent', end: true },
  { to: '/app/emails/templates', label: 'Templates', end: false },
  { to: '/app/emails/types', label: 'Email types', end: true },
  { to: '/app/emails/compose', label: 'Compose', end: true },
] as const;

/**
 * The gate the Templates and Compose tabs show without the emailTemplates
 * feature (§6.3 visible-but-locked): the tabs stay in the sub-nav, the surface
 * explains itself calmly, and nothing an org authored is deleted - server-side
 * template resolution simply falls back to the built-in copy meanwhile.
 */
function EmailTemplatesLocked({ isAdmin }: { isAdmin: boolean }) {
  return (
    <EmptyState
      title="Email templates are not included in your plan"
      body="Emails still send using the built-in Safentia copy. Any templates you authored are kept safe and will apply again when your plan includes them."
      action={
        <UpsellNotice
          message="Upgrade to author your own email templates and compose one-off emails."
          isAdmin={isAdmin}
        />
      }
    />
  );
}

export function EmailsRoutes() {
  const { claims } = useAuth();
  // Before the admin early-return below: hooks must run unconditionally.
  const billing = useEntitlements();
  const templatesLocked =
    !billing.loading && !billing.entitlements.features.emailTemplates;
  if (claims?.roles.admin !== true) {
    return (
      <EmptyState
        title="Administrator access required"
        body="The email log and templates are administrator ground. If you believe you should have access here, ask an administrator at your organisation."
      />
    );
  }
  return (
    <div className={styles.layout}>
      <nav className={styles.subNav} aria-label="Email sections">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              isActive
                ? `${styles.subNavLink} ${styles.subNavLinkActive}`
                : styles.subNavLink
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <div className={styles.content}>
        <Routes>
          <Route index element={<SentEmailsPage />} />
          <Route
            path="templates"
            element={
              templatesLocked ? (
                <EmailTemplatesLocked isAdmin={billing.isAdmin} />
              ) : (
                <Suspense fallback={<LoadingNote>Loading templates</LoadingNote>}>
                  <EmailTemplatesPage />
                </Suspense>
              )
            }
          />
          <Route
            path="templates/:templateId"
            element={
              templatesLocked ? (
                <EmailTemplatesLocked isAdmin={billing.isAdmin} />
              ) : (
                <Suspense fallback={<LoadingNote>Loading the template</LoadingNote>}>
                  <EmailTemplateEditor />
                </Suspense>
              )
            }
          />
          <Route
            path="types"
            element={
              <Suspense fallback={<LoadingNote>Loading email types</LoadingNote>}>
                <EmailTypesPage />
              </Suspense>
            }
          />
          <Route
            path="compose"
            element={
              templatesLocked ? (
                <EmailTemplatesLocked isAdmin={billing.isAdmin} />
              ) : (
                <Suspense fallback={<LoadingNote>Loading the composer</LoadingNote>}>
                  <ComposePage />
                </Suspense>
              )
            }
          />
        </Routes>
      </div>
    </div>
  );
}
