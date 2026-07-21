// ============================================================================
// useUserOrganisations - the web twin of FireRite/src/auth/useUserOrganisations.
//
// The organisations the signed-in user belongs to, in the current environment,
// with their display names and which one is active.
//
// A user can be a member of several orgs (the reverse index /userOrgs/{uid}). We
// SUBSCRIBE to that index (a live onValue, so being added to or removed from an
// organisation mid-session updates the switcher without a reload), then resolve
// each org's profile name with one-shot get()s per change. Cross-environment
// membership is out of scope: the /test and /live roots are isolated, so we only
// ever list orgs in the user's current environment (the only data their session
// can see, brief 4.8).
// ============================================================================

import { useEffect, useState } from 'react';
import { ref, get, onValue } from 'firebase/database';
import { firebase } from '../firebase';
import { useAuth } from './AuthProvider';
import type { OrgProfile } from '../types';

export interface UserOrganisation {
  orgId: string;
  name: string;
  isCurrent: boolean;
}

export interface UserOrganisationsState {
  organisations: UserOrganisation[];
  loading: boolean;
  /** True once the user is known to belong to more than one org (drives whether
   *  the switcher is shown at all). */
  hasMultiple: boolean;
}

export function useUserOrganisations(): UserOrganisationsState {
  const { user, claims, paths } = useAuth();
  const [organisations, setOrganisations] = useState<UserOrganisation[]>([]);
  const [loading, setLoading] = useState(true);

  const uid = user?.uid;
  const currentOrgId = claims?.orgId;

  useEffect(() => {
    if (!uid || !claims || !paths) {
      setOrganisations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // `stale` covers both unmount and effect re-run: a name resolution that was
    // in flight when the listener detached must not write into the next
    // subscription's state.
    let stale = false;

    const resolve = async (index: Record<string, boolean> | null) => {
      const ids = index ? Object.keys(index) : [];
      const named = await Promise.all(
        ids.map(async (orgId) => {
          let name = orgId;
          try {
            const profileSnap = await get(
              ref(firebase.db(), paths.db.orgProfile(orgId)),
            );
            const profile = profileSnap.val() as OrgProfile | null;
            if (profile?.name) {
              name = profile.name;
            }
          } catch {
            // A missing/unreadable profile falls back to the id, never throws.
          }
          return { orgId, name, isCurrent: orgId === currentOrgId };
        }),
      );
      named.sort((a, b) => a.name.localeCompare(b.name));
      if (!stale) {
        setOrganisations(named);
        setLoading(false);
      }
    };

    const unsubscribe = onValue(
      ref(firebase.db(), paths.db.userOrgs(uid)),
      (snapshot) => {
        void resolve(snapshot.val() as Record<string, boolean> | null).catch(
          () => {
            if (!stale) {
              setOrganisations([]);
              setLoading(false);
            }
          },
        );
      },
      () => {
        // Listener-level failure (e.g. permission mid-sign-out): empty list,
        // matching the old one-shot read's failure behaviour.
        if (!stale) {
          setOrganisations([]);
          setLoading(false);
        }
      },
    );

    return () => {
      stale = true;
      unsubscribe();
    };
  }, [uid, currentOrgId, claims, paths]);

  return {
    organisations,
    loading,
    hasMultiple: organisations.length > 1,
  };
}
