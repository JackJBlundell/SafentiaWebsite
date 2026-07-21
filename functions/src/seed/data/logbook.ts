// ============================================================================
// Log book entries (brief 10), of varied types, so the Phase 2 web viewer has
// real history to render. The log book is APP-WRITE-ONLY and append-only in
// Phase 1; the seed pre-populates it as if those writes had already happened.
//
// The entry types are represented (fireIncident, falseAlarm, fireDoorRecord,
// serviceConfirmed, assessorAction, fraCompleted). Entries are keyed by building
// with deterministic ids so the seed stays idempotent.
// ============================================================================

import type { LogBookEntry, LogBookType } from '../../shared/types';
import { BUILDING, UID, days } from '../ids';

export interface SeedLogEntry {
  buildingId: string;
  id: string;
  entry: LogBookEntry;
}

function entry(
  buildingId: string,
  id: string,
  type: LogBookType,
  at: number,
  byUid: string,
  payload: Record<string, unknown>,
): SeedLogEntry {
  return { buildingId, id, entry: { type, payload, byUid, at } };
}

export const SEED_LOG_ENTRIES: SeedLogEntry[] = [
  // Tower A - a spread of history.
  entry(BUILDING.meridianTowerA, 'log-a-falsealarm', 'falseAlarm', days(-47), UID.assessor, {
    cause: 'Cooking fumes, Level 2 kitchenette',
    zone: 'Zone 2',
    silencedBy: 'Site duty manager',
    notes: 'Investigated and reset; no fire.',
  }),
  entry(BUILDING.meridianTowerA, 'log-a-service', 'serviceConfirmed', days(-40), UID.admin, {
    service: 'fireAlarmService',
    contractor: 'Northwest Fire Systems Ltd',
    outcome: 'Pass',
    certificateRef: 'NFS-2026-1184',
  }),
  entry(BUILDING.meridianTowerA, 'log-a-assessoraction', 'assessorAction', days(-21), UID.assessor, {
    action: 'Fire risk assessment carried out',
    summary: 'Annual PAS 79 assessment completed; action plan issued.',
  }),
  entry(BUILDING.meridianTowerA, 'log-a-firedoor', 'fireDoorRecord', days(-15), UID.assessor, {
    location: 'Level 3 cross-corridor door FD30S',
    result: 'Defect',
    detail: 'Gaps exceed tolerance; remedial work raised.',
  }),
  entry(BUILDING.meridianTowerA, 'log-a-system', 'fraCompleted', days(-18), UID.admin, {
    summary: 'Fire risk assessment completed and released to customer.',
  }),
  // Tower B.
  entry(BUILDING.meridianTowerB, 'log-b-service', 'serviceConfirmed', days(-38), UID.admin, {
    service: 'extinguisherMaintenance',
    contractor: 'Northwest Fire Systems Ltd',
    outcome: 'Pass',
    certificateRef: 'NFS-2026-1190',
  }),
  entry(BUILDING.meridianTowerB, 'log-b-system', 'fraCompleted', days(-31), UID.admin, {
    summary: 'Fire risk assessment completed and released to customer.',
  }),
  // Lodge House (care home) - a real incident on record.
  entry(BUILDING.northgateLodgeHouse, 'log-lodge-incident', 'fireIncident', days(-120), UID.admin, {
    location: 'First-floor laundry',
    cause: 'Tumble-dryer lint ignition',
    outcome: 'Extinguished by staff; fire service attended; no injuries.',
    evacuated: true,
  }),
  entry(BUILDING.northgateLodgeHouse, 'log-lodge-drill', 'assessorAction', days(-30), UID.assessor, {
    action: 'Evacuation drill observed',
    summary: 'Progressive horizontal evacuation drill; assembly within target time.',
  }),
  // Riverside Mill.
  entry(BUILDING.riversideMill, 'log-riverside-firedoor', 'fireDoorRecord', days(-5), UID.assessor, {
    location: 'Level 3 cross-corridor fire door',
    result: 'Defect',
    detail: 'Self-closer disconnected; remedial action raised.',
  }),
];
