// ============================================================================
// SettingsRoutes - the settings area's router, admin gate and sub-nav.
//
// Mirrors StaffRoutes: the shell hides the nav item from non-admins, and this
// gate covers the direct-URL case. The sub-nav switches between the settings
// surfaces (organisation profile / risk scoring / reminders / AI guidance /
// billing): a left column of
// links beside the content on desktop, collapsing to the familiar horizontal
// tabs on smaller screens. Same links, same DOM, two presentations.
// ============================================================================

import { lazy, Suspense } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState } from '../ui/Page';
import { Skeleton } from '../ui/Skeleton';
import { OrganisationSettingsPage } from './OrganisationSettingsPage';
import { RagSettingsPage } from './RagSettingsPage';
import { NotificationSettingsPage } from './NotificationSettingsPage';
import { AiGuidanceSettingsPage } from './AiGuidanceSettingsPage';
import styles from './SettingsRoutes.module.css';

// Code-split (CustomersRoutes precedent): the Billing page pulls in
// @stripe/react-stripe-js, which must stay out of the pre-rendered console
// chunk - the SSG build cannot carry Stripe.js weight for every visitor who
// never opens Billing.
const BillingSettingsPage = lazy(() =>
  import('../billing/BillingSettingsPage').then((module) => ({
    default: module.BillingSettingsPage,
  })),
);

const SUB_NAV = [
  { to: '/app/settings', label: 'Organisation', end: true },
  { to: '/app/settings/rag', label: 'Risk scoring', end: false },
  // The path stays /reminders (it is bookmarked and linked from email footers)
  // while the surface now covers every scheduled reminder, not reviews alone.
  { to: '/app/settings/reminders', label: 'Reminders', end: false },
  // The org's own steer for the AI summary writer. Its own surface rather than a
  // card on another page: it is a different decision from risk banding or
  // reminder schedules, and the copy explaining what it is - and what it is NOT,
  // namely report wording - needs the room.
  { to: '/app/settings/ai-guidance', label: 'AI guidance', end: false },
  { to: '/app/settings/billing', label: 'Billing', end: false },
] as const;

export function SettingsRoutes() {
  const { claims } = useAuth();
  if (claims?.roles.admin !== true) {
    return (
      <EmptyState
        title="Administrator access required"
        body="You need administrator access for this area. If you believe you should have it, ask an administrator at your organisation."
      />
    );
  }
  return (
    <div className={styles.layout}>
      <nav className={styles.subNav} aria-label="Settings sections">
        {SUB_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              isActive ? `${styles.subNavLink} ${styles.subNavLinkActive}` : styles.subNavLink
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className={styles.content}>
        <Routes>
          <Route index element={<OrganisationSettingsPage />} />
          <Route path="rag" element={<RagSettingsPage />} />
          <Route path="reminders" element={<NotificationSettingsPage />} />
          <Route path="ai-guidance" element={<AiGuidanceSettingsPage />} />
          <Route
            path="billing"
            element={
              <Suspense fallback={<Skeleton height="8rem" />}>
                <BillingSettingsPage />
              </Suspense>
            }
          />
        </Routes>
      </div>
    </div>
  );
}
