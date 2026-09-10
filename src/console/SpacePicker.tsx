// ============================================================================
// SpacePicker - where someone who holds more than one space says which one they
// want to be in, shown once per tab session immediately after signing in.
//
// The product is two halves and a person can legitimately sit in both: staff at
// the fire-safety firm they work for, and a named contact at a customer of a
// different firm. The token holds exactly one of those at a time, so entering a
// space is a server-side re-mint of the claims, not a client-side toggle - this
// screen only asks the question and then calls setActiveOrganisation.
//
// The halves are presented as two labelled groups because they mean different
// things ("records I produce" against "records produced about my buildings"),
// and each entry says which half it belongs to in words: nothing here is
// distinguished by colour alone (brief 18.5). The two groups additionally
// differ in the SHAPE of their marks - a rounded square for a staff console, a
// disc for a customer account - which is a second non-colour signal, never the
// only one.
//
// Someone holding exactly ONE space never reaches this screen: ConsoleGate takes
// them straight in, so the overwhelming majority see no change at all.
// ============================================================================

import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { activateSpace } from '../auth/activateSpace';
import type { SessionClaims } from '../auth/claims';
import { rememberSpaceChoice } from '../auth/spaceChoice';
import { Button } from '../components/Button';
import { Wordmark } from '../components/Wordmark';
import { readableTextOn } from '../design/tokens/contrast';
import type { UserSpace } from '../types';
import { useSuperAdminClaim } from './admin/useSuperAdminClaim';
import { useImageFailed } from './useImageFailed';
import styles from './SpacePicker.module.css';

interface SpacePickerProps {
  spaces: UserSpace[];
  /** Called once the session is acting in the chosen space, so the gate can
   *  stop asking and render the console. */
  onChosen: () => void;
}

/** Identity for a space within one render: the pair IS the space, and a portal
 *  space at the same org as a staff space must not collide with it. */
function spaceId(space: UserSpace): string {
  return `${space.kind}:${space.orgId}:${space.customerId ?? ''}`;
}

/**
 * Whether the freshly refreshed token actually names the space that was chosen.
 *
 * The space IS the (orgId, customerId) pair, exactly as spaceId above says: a
 * customer portal and the staff console of the firm that assesses it share an
 * orgId, and a staff session carries `customerId: undefined`, so comparing the
 * org alone would read "opened the portal" off a token still holding the staff
 * claims. Both sides are normalised to null so undefined and absent are the
 * same thing.
 */
function claimsMatchSpace(
  claims: SessionClaims | null,
  space: UserSpace,
): boolean {
  // Falsy rather than `!== null`: null is the documented "no session / no
  // membership" answer, and guarding on the value itself also survives a caller
  // that never resolved one at all.
  if (!claims) {
    return false;
  }
  return (
    claims.orgId === space.orgId &&
    (claims.customerId ?? null) === (space.customerId ?? null)
  );
}

/** How a space reads in a log line: org and customer, never a name (names are
 *  display strings and two spaces can share one). */
function describeSpace(orgId?: string, customerId?: string): string {
  return `${orgId ?? 'none'}/${customerId ?? '-'}`;
}

/** The code a person can read out to support. Every Firebase and callable error
 *  carries one; anything else is reported without a code rather than with a
 *  meaningless placeholder. */
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Whether a space's name is really just its record id.
 *
 * Security rules let a token read only the customer it names, so every portal
 * space EXCEPT the active one usually fails to resolve a display name and falls
 * back to the id. That is expected, not a fault, and the row is designed for it
 * rather than left to render a raw key where a company name should be. The test
 * is deliberately narrow - unbroken, at least sixteen characters and containing
 * a digit - so a real single-word organisation name is never mistaken for a key.
 */
function looksLikeIdentifier(name: string): boolean {
  return /^[-_A-Za-z0-9]{16,}$/.test(name) && /\d/.test(name);
}

/** Up to two initials for the row's mark, from the words of a name. */
function initials(name: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, 2);
  return words.map((word) => word[0]?.toUpperCase() ?? '').join('');
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
} as const;

/** Stands in for the initials on a row whose name never resolved. */
const BuildingIcon = (
  <svg {...iconProps} className={styles.markIcon}>
    <path d="M4 20.5h16" />
    <path d="M6 20.5V6.5l7-3v17" />
    <path d="M13 10.5h5v10" />
    <path d="M9 9.5h1M9 13h1M9 16.5h1M15.5 14h1" />
  </svg>
);

const ChevronIcon = (
  <svg {...iconProps} className={styles.chevron}>
    <path d="M9 5.5 15.5 12 9 18.5" />
  </svg>
);

/**
 * One row's identity mark. A component rather than inline JSX because it needs
 * per-row state - whether that row's logo loaded - and a hook cannot be called
 * inside the map that renders the rows.
 *
 * A logo whose object has been deleted, or whose url never resolved, is treated
 * as no logo at all: it falls through to the monogram (or the building glyph for
 * an unresolved name) rather than leaving the browser's broken-image icon sitting
 * where the organisation's identity should be.
 */
function PickerMark({
  space,
  unresolved,
}: {
  space: UserSpace;
  unresolved: boolean;
}) {
  const logo = useImageFailed(space.logoUrl);
  const hasLogo = Boolean(space.logoUrl) && !logo.failed;

  return (
    <span
      className={`${styles.mark} ${
        space.kind === 'portal' ? styles.markPortal : styles.markStaff
      }`}
      aria-hidden="true"
      /* The org's brand colour is used ONLY as the mark's fill, with a readable
         ink computed for it (readableTextOn) - an arbitrary org colour has any
         contrast, so it can never be trusted as text. No brand colour keeps the
         token default. The tint comes back when a logo fails, since the mark is
         once again carrying a monogram. */
      style={
        hasLogo || !space.brandColor
          ? undefined
          : {
              background: space.brandColor,
              color: readableTextOn(space.brandColor, '#ffffff', '#10141a'),
            }
      }
    >
      {hasLogo ? (
        <img
          className={styles.markLogo}
          src={space.logoUrl}
          alt=""
          onError={logo.onError}
        />
      ) : unresolved ? (
        BuildingIcon
      ) : (
        initials(space.name)
      )}
    </span>
  );
}

export function SpacePicker({ spaces, onChosen }: SpacePickerProps) {
  const { user, refreshSession, signOut } = useAuth();
  const navigate = useNavigate();
  // A super admin can enter the platform console straight from the picker, not
  // only from the in-console switcher. Platform is not a space (no claim
  // re-mint), so entering it settles the picker and navigates to /app/admin,
  // where AdminRoutes renders off the superAdmin claim independently of whatever
  // space the session currently holds.
  const isSuperAdmin = useSuperAdminClaim() === 'granted';
  // Which entry is being entered, so the busy state sits on the button the
  // person actually pressed rather than blanking the whole screen.
  const [entering, setEntering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enterPlatform = useCallback(() => {
    if (entering) {
      return;
    }
    if (user?.uid) {
      rememberSpaceChoice(user.uid);
    }
    // Navigate first so the gate re-renders with the URL already at /app/admin,
    // then settle the picker so it steps out of the way.
    navigate('/app/admin');
    onChosen();
  }, [entering, navigate, onChosen, user?.uid]);

  const choose = useCallback(
    async (space: UserSpace) => {
      if (entering) {
        return;
      }
      const uid = user?.uid;
      // Choosing the space the claims already point at needs no re-mint: the
      // session is there, so this is purely "stop asking me".
      if (space.isCurrent) {
        if (uid) {
          rememberSpaceChoice(uid);
        }
        onChosen();
        return;
      }
      setEntering(spaceId(space));
      setError(null);
      try {
        await activateSpace(space.orgId, space.customerId);
        const resolved = await refreshSession();
        // VERIFY THE OUTCOME - a catch alone is not enough here.
        //
        // setActiveOrganisation answers 200 on every attempt (confirmed in the
        // live logs), and the forced token refresh resolves happily whatever the
        // token turns out to contain. So there is a real path where the re-mint
        // has not reached the token we just fetched, NOTHING throws, and this
        // screen calls onChosen and steps aside - dropping the person into a
        // space they did not pick, having apparently done as they asked. The
        // claims ARE the session, so a token naming somewhere else is a failed
        // switch, and the picker must say so and stay put.
        if (!claimsMatchSpace(resolved, space)) {
          console.error(
            '[Safentia auth] open space claims mismatch',
            `requested ${describeSpace(space.orgId, space.customerId)}, active ${describeSpace(resolved?.orgId, resolved?.customerId)}`,
          );
          setError(
            `We could not open ${space.name} just now - your sign-in is still in its previous space. Please try again, or choose a different space. (auth/space-not-applied)`,
          );
          setEntering(null);
          return;
        }
        if (uid) {
          rememberSpaceChoice(uid);
        }
        onChosen();
      } catch (error) {
        // Keep the error. Discarding it is what made the reported failure
        // undiagnosable: the cause was in hand and thrown away, leaving nothing
        // for support to work from beyond "it didn't work".
        console.error('[Safentia auth] open space', error);
        // The person is still signed in and still holds every space, so the
        // screen stays put with its options live rather than stranding them.
        const code = errorCode(error);
        setError(
          `We could not open ${space.name} just now. Please try again, or choose a different space.${
            code ? ` (${code})` : ''
          }`,
        );
        setEntering(null);
      }
    },
    [entering, onChosen, refreshSession, user?.uid],
  );

  const staffSpaces = spaces.filter((space) => space.kind === 'staff');
  const portalSpaces = spaces.filter((space) => space.kind === 'portal');

  const group = (
    id: string,
    label: string,
    hint: string,
    icon: ReactNode,
    members: UserSpace[],
  ) =>
    members.length > 0 && (
      <section className={styles.group}>
        <div className={styles.groupHeader}>
          <span className={styles.groupIcon}>{icon}</span>
          <div className={styles.groupText}>
            <h2 className={styles.groupHeading} id={id}>
              {label}
            </h2>
            <p className={styles.groupHint}>{hint}</p>
          </div>
        </div>
        <ul className={styles.options} aria-labelledby={id}>
          {members.map((space) => {
            const key = spaceId(space);
            const busy = entering === key;
            // An unresolved name is shown as a reference line under a generic
            // title, so the row reads as deliberate rather than as a bug.
            const unresolved = looksLikeIdentifier(space.name);
            const title = unresolved
              ? space.kind === 'portal'
                ? 'Customer account'
                : 'Organisation'
              : space.name;
            return (
              <li key={key}>
                <button
                  type="button"
                  className={styles.option}
                  aria-current={space.isCurrent ? 'true' : undefined}
                  disabled={entering !== null}
                  onClick={() => void choose(space)}
                >
                  <PickerMark space={space} unresolved={unresolved} />
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{title}</span>
                    <span className={styles.optionMeta}>
                      {space.kind === 'portal'
                        ? space.orgName
                          ? `Customer account, assessed by ${space.orgName}`
                          : 'Customer account'
                        : 'Staff console'}
                    </span>
                    {unresolved && (
                      <span className={styles.reference}>
                        Reference {space.name}
                      </span>
                    )}
                  </span>
                  <span className={styles.optionAside}>
                    {space.isCurrent && (
                      <span className={styles.currentPill}>Currently open</span>
                    )}
                    {busy && <span className={styles.optionState}>Opening...</span>}
                    {ChevronIcon}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );

  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <div className={styles.intro}>
          <Wordmark size="lg" />
          <h1 className={styles.heading}>Where would you like to go?</h1>
          <p className={styles.copy}>
            Your account has access to more than one space. Choose one to open
            now; you can move between them at any time from the menu.
          </p>
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        {/* Announced politely so a screen-reader user hears the wait without
            the focused button being torn out from under them. */}
        <span className="sr-only" role="status">
          {entering ? 'Opening your space' : ''}
        </span>

        {group(
          'space-picker-staff',
          'Organisations you work for',
          'The full console for the organisation you are a member of.',
          BuildingIcon,
          staffSpaces,
        )}
        {group(
          'space-picker-portal',
          'Customer accounts you can view',
          'Assessments, actions and reports for the buildings you are responsible for.',
          <svg {...iconProps} className={styles.markIcon}>
            <path d="M12 3.5 4.5 6.5v5.2c0 4.3 3 7.5 7.5 8.8 4.5-1.3 7.5-4.5 7.5-8.8V6.5Z" />
            <path d="M9 12l2.2 2.2 4-4.4" />
          </svg>,
          portalSpaces,
        )}

        {isSuperAdmin && (
          <section className={styles.group}>
            <div className={styles.groupHeader}>
              <span className={styles.groupIcon}>
                <svg {...iconProps} className={styles.markIcon}>
                  <path d="M12 3l7 3v5c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6z" />
                  <path d="M9.5 12l1.8 1.8 3.5-3.8" />
                </svg>
              </span>
              <div className={styles.groupText}>
                <h2 className={styles.groupHeading} id="space-picker-platform">
                  Platform
                </h2>
                <p className={styles.groupHint}>
                  Oversight across every organisation on Safentia.
                </p>
              </div>
            </div>
            <ul className={styles.options} aria-labelledby="space-picker-platform">
              <li>
                <button
                  type="button"
                  className={styles.option}
                  disabled={entering !== null}
                  onClick={enterPlatform}
                >
                  <span
                    className={`${styles.mark} ${styles.markStaff}`}
                    aria-hidden="true"
                  >
                    <svg {...iconProps} className={styles.markIcon}>
                      <path d="M12 3l7 3v5c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6z" />
                      <path d="M9.5 12l1.8 1.8 3.5-3.8" />
                    </svg>
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>Super Admin Dashboard</span>
                    <span className={styles.optionMeta}>Platform oversight</span>
                  </span>
                  <span className={styles.optionAside}>{ChevronIcon}</span>
                </button>
              </li>
            </ul>
          </section>
        )}

        <div className={styles.footer}>
          {user?.email && (
            <p className={styles.account}>
              Signed in as <strong>{user.email}</strong>
            </p>
          )}
          <Button
            variant="secondary"
            disabled={entering !== null}
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
