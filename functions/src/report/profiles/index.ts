// ============================================================================
// Report profile selection. One place maps a template's `standard` to the
// profile that renders it. Anything unknown, custom or absent resolves to the
// generic defaultProfile, so the report engine ALWAYS has a profile and a novel
// or untagged template degrades to a sensible generic report (brief 18.3).
// ============================================================================

import type { ReportStandard } from '../../shared/types';
import type { ReportProfile } from './types';
import { defaultProfile } from './default';
import { pas79Profile } from './pas79';
import { bs9792Profile } from './bs9792';

const PROFILES: Record<ReportStandard, ReportProfile> = {
  pas79: pas79Profile,
  bs9792: bs9792Profile,
  custom: defaultProfile,
};

/** Resolve the report profile for an assessment's template standard. Undefined
 *  or an unrecognised value → the generic default. */
export function selectProfile(standard: ReportStandard | undefined): ReportProfile {
  if (standard && Object.prototype.hasOwnProperty.call(PROFILES, standard)) {
    return PROFILES[standard];
  }
  return defaultProfile;
}

export type { ReportProfile } from './types';
export { defaultProfile, pas79Profile, bs9792Profile };
