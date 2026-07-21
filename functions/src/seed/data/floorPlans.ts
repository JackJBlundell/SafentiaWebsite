// ============================================================================
// Floor plans (brief 10). Present on SOME buildings, deliberately ABSENT on at
// least one (the Harbourside unit and the never-assessed Annexe have none), so
// the flag feature's no-floor-plan path is exercised (brief 8 step 1).
//
// Each plan's image is generated and uploaded by the seed; the imageUrl is
// injected after upload so the record and the stored object never drift.
// ============================================================================

import type { FloorPlan } from '../../shared/types';
import { BUILDING, PLAN } from '../ids';

export interface SeedFloorPlan {
  buildingId: string;
  planId: string;
  /** Storage key under which the plan PNG is uploaded. */
  storageKey: string;
  /** Built without imageUrl; the seed fills it after upload. */
  meta: Omit<FloorPlan, 'imageUrl'>;
}

export const SEED_FLOOR_PLANS: SeedFloorPlan[] = [
  {
    buildingId: BUILDING.meridianTowerA,
    planId: PLAN.towerAGround,
    storageKey: PLAN.towerAGround,
    meta: {
      name: 'Ground Floor',
      description: 'Reception, plant room and main escape routes.',
    },
  },
  {
    buildingId: BUILDING.meridianTowerA,
    planId: PLAN.towerAFirst,
    storageKey: PLAN.towerAFirst,
    meta: {
      name: 'First Floor',
      description: 'Office floor plate with protected stair cores.',
    },
  },
  {
    buildingId: BUILDING.meridianTowerB,
    planId: PLAN.towerBGround,
    storageKey: PLAN.towerBGround,
    meta: {
      name: 'Ground Floor',
      description: 'Lobby and retail units at street level.',
    },
  },
  {
    buildingId: BUILDING.riversideMill,
    planId: PLAN.riversideGround,
    storageKey: PLAN.riversideGround,
    meta: {
      name: 'Ground Floor',
      description: 'Open workshop floor and goods entrance.',
    },
  },
  {
    buildingId: BUILDING.northgateLodgeHouse,
    planId: PLAN.lodgeGround,
    storageKey: PLAN.lodgeGround,
    meta: {
      name: 'Ground Floor',
      description: 'Resident rooms, day room and assisted-evacuation routes.',
    },
  },
  // NOTE: BUILDING.harboursideUnit and BUILDING.meridianAnnexe intentionally
  // have NO floor plans (brief 10 - exercise the no-floor-plan path).
];
