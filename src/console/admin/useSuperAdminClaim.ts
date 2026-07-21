// ============================================================================
// useSuperAdminClaim - is the signed-in user a platform super admin?
//
// The `superAdmin: true` custom claim (granted by functions'
// scripts/grantSuperAdmin.ts) is what the rules cascade trusts. The session's
// SessionClaims shape (src/auth/claims.ts) deliberately models ORG membership
// and is owned by the portal work, so rather than widening it this hook reads
// the RAW ID-token result itself - the claim is a platform concern, not an org
// one, and this keeps the two surfaces from colliding.
//
// Hiding-vs-security: this gates PRESENTATION only. The real boundary is
// database.rules.json's superAdmin read cascade; a hand-typed /app/admin URL
// without the claim renders the denial screen and every read would fail anyway.
// ============================================================================

import { useEffect, useState } from 'react';
import { getIdTokenResult } from 'firebase/auth';
import { useAuth } from '../../auth/AuthProvider';

export type SuperAdminState = 'loading' | 'granted' | 'denied';

export function useSuperAdminClaim(): SuperAdminState {
  const { user } = useAuth();
  const [state, setState] = useState<SuperAdminState>('loading');

  useEffect(() => {
    let active = true;
    if (!user) {
      setState('denied');
      return;
    }
    setState('loading');
    // Force a token refresh: the superAdmin claim is granted server-side (the
    // grantSuperAdmin script) to an account that is usually ALREADY signed in,
    // so the cached ID token predates the grant and would read 'denied' until a
    // full re-login. Refreshing here means a freshly-granted operator sees the
    // platform entry on the next mount/reload, not only after signing out and in.
    getIdTokenResult(user, true)
      .then((result) => {
        if (active) {
          setState(result.claims.superAdmin === true ? 'granted' : 'denied');
        }
      })
      .catch(() => {
        // A token read failure must fail CLOSED.
        if (active) {
          setState('denied');
        }
      });
    return () => {
      active = false;
    };
  }, [user]);

  return state;
}
