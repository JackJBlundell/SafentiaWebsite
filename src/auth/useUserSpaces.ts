// ============================================================================
// useUserSpaces - every space this account can enter, in the current
// environment, with display names and which one the session is acting in.
//
// The product has two halves and a token holds exactly ONE of them: a staff
// token carries `orgId`, a portal token carries `portalOrgId` + `customerId`
// and never both. So "which spaces do I have" cannot be read off the claims -
// it is the union of two reverse indexes:
//   - /userOrgs/{uid}/{orgId}: true                 the organisations they work for
//   - /customerUserIndex/{uid}/{spaceKey}           the customers they can view
// Both are SUBSCRIBED (live onValue), so joining or leaving either half updates
// the picker and the switcher without a reload. This replaces the older
// useUserOrganisations, which watched only the staff index and was exactly why
// a newly joined portal space was invisible to the person who had just joined it.
//
// Display names are one-shot get()s per index change, deduplicated within a
// pass so several spaces at one organisation cost one profile read, not three.
// A name that cannot be read degrades to the id: security rules only let a
// portal token read the ONE customer its claims name, so a person holding
// several portal spaces can genuinely only resolve the active one, and an
// unreadable name must never take the switcher down with it.
//
// Cross-environment membership is out of scope: the /test and /live roots are
// isolated, so we only ever list spaces in the session's own environment
// (brief 4.8).
// ============================================================================

import { useEffect, useState } from 'react';
import { ref, get, onValue } from 'firebase/database';
import { firebase } from '../firebase';
import { useAuth } from './AuthProvider';
import type { Customer, CustomerUserIndexEntry, OrgProfile, UserSpace } from '../types';

export interface UserSpacesState {
  spaces: UserSpace[];
  loading: boolean;
  /** True once the account is known to hold more than one space (drives whether
   *  the picker is shown at all, and whether the switcher is a disclosure). */
  hasMultiple: boolean;
}

/** The raw portal index: `{[spaceKey]: {orgId, customerId}}`. Entries are read
 *  defensively because the shape is server-written and a malformed one must be
 *  skipped rather than render an undefined space. */
type PortalIndex = Record<string, CustomerUserIndexEntry | null> | null;

/** Staff spaces sort before portal ones, then alphabetically, so both the
 *  picker's groups and the switcher's list have one stable order. */
function compareSpaces(a: UserSpace, b: UserSpace): number {
  if (a.kind !== b.kind) {
    return a.kind === 'staff' ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

export function useUserSpaces(): UserSpacesState {
  const { user, claims, paths } = useAuth();
  const [spaces, setSpaces] = useState<UserSpace[]>([]);
  const [loading, setLoading] = useState(true);

  const uid = user?.uid;
  const currentOrgId = claims?.orgId;
  const currentCustomerId = claims?.customerId;

  useEffect(() => {
    if (!uid || !claims || !paths) {
      setSpaces([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // `stale` covers both unmount and effect re-run: name resolution that was in
    // flight when the listeners detached must not write into the next
    // subscription's state.
    let stale = false;
    // The two listeners fire independently and either may arrive first. We keep
    // the latest snapshot of each and re-merge on every arrival, so the list is
    // never half a picture, and `generation` makes sure only the newest pass may
    // publish (an older, slower name resolution cannot overwrite a newer one).
    let staffIndex: Record<string, boolean> | null = null;
    let portalIndex: PortalIndex = null;
    let staffReported = false;
    let portalReported = false;
    let generation = 0;

    const db = firebase.db();

    /** The identity fields a space shows for its organisation, resolved once per
     *  org per pass and shared by every space at that org. */
    interface OrgIdentity {
      name: string | undefined;
      logoUrl: string | undefined;
      brandColor: string | undefined;
    }

    const orgIdentity = (
      cache: Map<string, Promise<OrgIdentity>>,
      orgId: string,
    ): Promise<OrgIdentity> => {
      const cached = cache.get(orgId);
      if (cached) {
        return cached;
      }
      const pending = get(ref(db, paths.db.orgProfile(orgId)))
        .then((snapshot) => {
          const profile = snapshot.val() as OrgProfile | null;
          return {
            name: profile?.name ?? undefined,
            logoUrl: profile?.logoUrl ?? undefined,
            // brand.primary is the org's fill colour; the picker decides a
            // readable ink to sit on it, so an unreadable profile just yields no
            // colour and a plain monogram, never a crash.
            brandColor: profile?.brand?.primary ?? undefined,
          };
        })
        .catch(() => ({ name: undefined, logoUrl: undefined, brandColor: undefined }));
      cache.set(orgId, pending);
      return pending;
    };

    const merge = async () => {
      const pass = ++generation;
      const orgIdentities = new Map<string, Promise<OrgIdentity>>();

      const staffIds = staffIndex ? Object.keys(staffIndex) : [];
      const portalEntries = Object.values(portalIndex ?? {}).filter(
        (entry): entry is CustomerUserIndexEntry =>
          Boolean(entry) &&
          typeof entry?.orgId === 'string' &&
          typeof entry?.customerId === 'string',
      );

      const staffSpaces = staffIds.map(
        async (orgId): Promise<UserSpace> => {
          const identity = await orgIdentity(orgIdentities, orgId);
          return {
            kind: 'staff',
            orgId,
            name: identity.name ?? orgId,
            ...(identity.logoUrl ? { logoUrl: identity.logoUrl } : {}),
            ...(identity.brandColor ? { brandColor: identity.brandColor } : {}),
            // A staff session is the one with no customer: the halves are
            // mutually exclusive in the token, so matching on orgId alone would
            // light up the staff entry while the user is in that org's portal.
            isCurrent: orgId === currentOrgId && !currentCustomerId,
          };
        },
      );

      const portalSpaces = portalEntries.map(
        async ({ orgId, customerId }): Promise<UserSpace> => {
          let name = customerId;
          try {
            const snapshot = await get(ref(db, paths.db.customer(orgId, customerId)));
            const customer = snapshot.val() as Customer | null;
            if (customer?.name) {
              name = customer.name;
            }
          } catch {
            // Unreadable customer (rules scope portal reads to the active space):
            // fall back to the id rather than throwing the whole list away.
          }
          const assessor = (await orgIdentity(orgIdentities, orgId)).name;
          return {
            kind: 'portal',
            orgId,
            customerId,
            name,
            // Context only, so an unresolvable assessor name is simply omitted
            // rather than shown as a raw id next to a real customer name.
            ...(assessor ? { orgName: assessor } : {}),
            isCurrent: orgId === currentOrgId && customerId === currentCustomerId,
          };
        },
      );

      const resolved = await Promise.all([...staffSpaces, ...portalSpaces]);
      resolved.sort(compareSpaces);
      if (stale || pass !== generation) {
        return;
      }
      setSpaces(resolved);
      // Only settle once BOTH halves have reported, so a fast staff index cannot
      // declare "one space, go straight in" while the portal index is still in
      // flight and about to add a second.
      if (staffReported && portalReported) {
        setLoading(false);
      }
    };

    const run = () => {
      void merge().catch(() => {
        // A merge can only fail on something unforeseen (the per-name reads all
        // catch their own): report what we can rather than hanging on loading.
        if (!stale) {
          setLoading(false);
        }
      });
    };

    const unsubscribeStaff = onValue(
      ref(db, paths.db.userOrgs(uid)),
      (snapshot) => {
        staffIndex = snapshot.val() as Record<string, boolean> | null;
        staffReported = true;
        run();
      },
      () => {
        // Listener-level failure (e.g. permission mid-sign-out): treat that half
        // as empty so the other half still renders.
        staffIndex = null;
        staffReported = true;
        run();
      },
    );

    const unsubscribePortal = onValue(
      ref(db, paths.db.customerUserIndex(uid)),
      (snapshot) => {
        portalIndex = snapshot.val() as PortalIndex;
        portalReported = true;
        run();
      },
      () => {
        portalIndex = null;
        portalReported = true;
        run();
      },
    );

    return () => {
      stale = true;
      unsubscribeStaff();
      unsubscribePortal();
    };
  }, [uid, currentOrgId, currentCustomerId, claims, paths]);

  return {
    spaces,
    loading,
    hasMultiple: spaces.length > 1,
  };
}
