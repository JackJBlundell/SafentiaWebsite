// ============================================================================
// Input validation (brief 5 / 18.4).
//
// Every Function entry point validates its input HERE before touching the
// database, against the `const` allow-lists in the types contract so "what values
// are legal" is stated exactly once (the same arrays the rules tests and the seed
// use). The rule throughout: reject bad input, never coerce it (brief 18.4). Free
// text gets explicit length ceilings so a client cannot push an unbounded blob
// into RTDB. Every failure is a structured 'invalid-argument' error naming the
// offending field, so the UI can point at it.
// ============================================================================

import {
  CUSTOMER_ROLES,
  ORG_ROLES,
  type CustomerRole,
  type CustomerRoleSet,
  type Environment,
  type OrgRole,
  type OrgRoleSet,
} from '../shared/types';
import { fail } from './errors';

// ----------------------------------------------------------------------------
// Length ceilings for free text. Chosen generously enough for real assessment
// prose (observations, narratives) yet bounded so no field can be abused. Stored
// once so limits are consistent across every validator.
// ----------------------------------------------------------------------------
export const TEXT_LIMITS = {
  email: 254, // RFC 5321 maximum addressable length.
  displayName: 120,
  password: 4096, // Firebase Auth's own ceiling; we only bound, Auth enforces strength.
  shortText: 200, // names, single-line fields.
  freeText: 5000, // observations, messages, narrative blocks.
} as const;

/** True when a value is a present, non-empty, trimmed string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Assert the payload is a plain object (the only legal callable input shape).
 * onCall can hand us null/undefined when a client sends nothing, so we guard
 * before any property access.
 */
export function assertObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw fail.invalidArgument('The request body was missing or malformed.');
  }
  return input as Record<string, unknown>;
}

/** The characters a Realtime Database key may NOT contain. `/` is the path
 *  separator, so an id carrying one addresses a DIFFERENT node than intended;
 *  the rest are rejected by the SDK itself and would surface as a 500 rather
 *  than a clean invalid-argument. */
const UNSAFE_DB_KEY = /[/.#$[\]]/;

/**
 * Validate a required id that will be interpolated into a database path. Beyond
 * requireString's trim and ceiling, this refuses any character that would let
 * the value escape its own key: a `reportId` of `realId/pdfPath` would otherwise
 * build a path one level deeper and let a write land on a sibling field.
 */
export function requireDbKey(
  input: Record<string, unknown>,
  field: string,
  max: number,
): string {
  const value = requireString(input, field, max);
  if (UNSAFE_DB_KEY.test(value)) {
    throw fail.invalidArgument(`The ${field} field is not a valid identifier.`, {
      field,
    });
  }
  return value;
}

/** Validate a required string field with a length ceiling; trims it. */
export function requireString(
  input: Record<string, unknown>,
  field: string,
  max: number,
): string {
  const value = input[field];
  if (!isNonEmptyString(value)) {
    throw fail.invalidArgument(`The ${field} field is required.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw fail.invalidArgument(`The ${field} field is too long.`, {
      field,
      max,
    });
  }
  return trimmed;
}

/** Validate an optional string field; returns undefined when absent. */
export function optionalString(
  input: Record<string, unknown>,
  field: string,
  max: number,
): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw fail.invalidArgument(`The ${field} field must be text.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > max) {
    throw fail.invalidArgument(`The ${field} field is too long.`, { field, max });
  }
  return trimmed;
}

/**
 * Validate a clearable optional string field (update paths only). Three intents
 * are distinguished, matching ClearableFields in the types contract: absent
 * returns undefined (leave the field unchanged), an explicit null returns null
 * (the CLEAR - writing null to RTDB deletes the key), and anything else is
 * validated exactly like optionalString. Create paths reject null before
 * calling this: there is nothing to clear on a record that does not exist yet.
 */
export function clearableString(
  input: Record<string, unknown>,
  field: string,
  max: number,
): string | null | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return optionalString(input, field, max);
}

/** Validate a required finite-number field (used for timestamps). */
export function requireNumber(
  input: Record<string, unknown>,
  field: string,
): number {
  const value = input[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fail.invalidArgument(`The ${field} field must be a number.`, { field });
  }
  return value;
}

/**
 * Validate an epoch-millis timestamp: a positive finite integer. We do not bound
 * it to "the future" because a job can legitimately be scheduled for now or be
 * back-dated by an admin; we only reject nonsense values.
 */
export function requireTimestamp(
  input: Record<string, unknown>,
  field: string,
): number {
  const value = requireNumber(input, field);
  if (!Number.isInteger(value) || value <= 0) {
    throw fail.invalidArgument(`The ${field} field must be a valid date.`, {
      field,
    });
  }
  return value;
}

/**
 * Validate an email's SHAPE only (presence + a single @ + bounded length). We do
 * NOT attempt deliverability or RFC-perfect parsing; that is the email provider's
 * job. A non-enumerating sign-in flow (brief 4.1) means we never reveal whether an
 * address exists, so shape is all we assert here.
 */
export function requireEmail(
  input: Record<string, unknown>,
  field = 'email',
): string {
  const raw = requireString(input, field, TEXT_LIMITS.email).toLowerCase();
  const at = raw.indexOf('@');
  // A valid address has exactly one @, with non-empty local and domain parts and
  // a dot in the domain. This rejects obvious rubbish without false-rejecting
  // real addresses.
  if (
    at <= 0 ||
    at !== raw.lastIndexOf('@') ||
    at === raw.length - 1 ||
    !raw.slice(at + 1).includes('.')
  ) {
    throw fail.invalidArgument('Please enter a valid email address.', { field });
  }
  return raw;
}

/**
 * Validate an org role set: a plain object whose keys are all known roles, whose
 * values are all literal `true`, and which is non-empty. This is the union model
 * (a user can hold several roles); we reject any unknown key rather than dropping
 * it, so a client cannot smuggle a fabricated role through.
 */
export function requireRoleSet(
  input: Record<string, unknown>,
  field = 'roles',
): OrgRoleSet {
  const value = input[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail.invalidArgument('At least one role must be provided.', { field });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw fail.invalidArgument('At least one role must be provided.', { field });
  }
  const allowed = new Set<string>(ORG_ROLES);
  const result: OrgRoleSet = {};
  for (const [key, flag] of entries) {
    if (!allowed.has(key)) {
      throw fail.invalidArgument(`Unknown role: ${key}.`, { field, role: key });
    }
    if (flag !== true) {
      // Roles are flags; only literal `true` is meaningful. `false` or a string
      // is rejected rather than coerced (brief 18.4).
      throw fail.invalidArgument(`Role ${key} must be set to true.`, {
        field,
        role: key,
      });
    }
    result[key as OrgRole] = true;
  }
  return result;
}

/**
 * Validate a clearable optional email field (update paths only). Same three
 * intents as clearableString - absent leaves it, null CLEARS it - but a present
 * value must pass the email shape check, so a contact record can never carry a
 * malformed address.
 */
export function clearableEmail(
  input: Record<string, unknown>,
  field = 'email',
): string | null | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return requireEmail(input, field);
}

/**
 * Validate a REQUIRED customer-portal role set: a plain object whose keys are
 * all known CUSTOMER_ROLES, whose values are all literal `true`, and which is
 * non-empty. The customer twin of requireRoleSet, used where a set of portal
 * roles must be present (portalInviteTeammate) rather than optionally cleared.
 * An unknown key is rejected rather than dropped, so a client cannot smuggle an
 * org-staff role - or a fabricated one - through a portal write.
 */
export function requireCustomerRoleSet(
  input: Record<string, unknown>,
  field = 'roles',
): CustomerRoleSet {
  const value = input[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail.invalidArgument('At least one role must be provided.', { field });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw fail.invalidArgument('At least one role must be provided.', { field });
  }
  const allowed = new Set<string>(CUSTOMER_ROLES);
  const result: CustomerRoleSet = {};
  for (const [key, flag] of entries) {
    if (!allowed.has(key)) {
      throw fail.invalidArgument(`Unknown role: ${key}.`, { field, role: key });
    }
    if (flag !== true) {
      // Roles are flags; only literal `true` is meaningful. `false` or a string
      // is rejected rather than coerced (brief 18.4).
      throw fail.invalidArgument(`Role ${key} must be set to true.`, {
        field,
        role: key,
      });
    }
    result[key as CustomerRole] = true;
  }
  return result;
}

/**
 * Validate a clearable optional CUSTOMER-portal role set (the flags a customer
 * contact should hold in the portal). Same flag discipline as requireRoleSet -
 * known keys only, literal `true` values, non-empty when present - but against
 * the CUSTOMER_ROLES allow-list, and clearable: absent leaves the field, an
 * explicit null CLEARS it (portal roles are optional on a contact).
 */
export function clearableCustomerRoleSet(
  input: Record<string, unknown>,
  field = 'portalRoles',
): CustomerRoleSet | null | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw fail.invalidArgument(`The ${field} field must be a set of roles.`, {
      field,
    });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw fail.invalidArgument('At least one role must be provided.', { field });
  }
  const allowed = new Set<string>(CUSTOMER_ROLES);
  const result: CustomerRoleSet = {};
  for (const [key, flag] of entries) {
    if (!allowed.has(key)) {
      throw fail.invalidArgument(`Unknown role: ${key}.`, { field, role: key });
    }
    if (flag !== true) {
      // Roles are flags; only literal `true` is meaningful. `false` or a string
      // is rejected rather than coerced (brief 18.4).
      throw fail.invalidArgument(`Role ${key} must be set to true.`, {
        field,
        role: key,
      });
    }
    result[key as CustomerRole] = true;
  }
  return result;
}

/**
 * Validate that a value is a member of a runtime allow-list (e.g. SEVERITIES,
 * JOB_STATUSES). Generic so every enum check shares one rejection path.
 */
export function requireEnum<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = input[field];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw fail.invalidArgument(`The ${field} field has an unexpected value.`, {
      field,
      allowed,
    });
  }
  return value as T;
}

/** The tenant object-path prefix every stored file for an org lives under
 *  (mirrors shared/paths storageFor: `{env}/orgs/{orgId}/...`). */
export function tenantStoragePrefix(env: Environment, orgId: string): string {
  return `${env}/orgs/${orgId}/`;
}

/**
 * Validate that a stored-file reference belongs to the CALLER'S OWN tenant. An
 * admin-supplied URL (org logo, floor-plan image) or Storage path (document) is a
 * pointer we later render or serve, so accepting an arbitrary value would let an
 * admin point their org's assets at another tenant's objects or at an external
 * host (an exfiltration/phishing vector). Two forms are accepted, both anchored
 * to the caller's env + orgId - reject, never coerce:
 *   1. A raw tenant object path: `{env}/orgs/{orgId}/...` (how SafentiaDocument
 *      stores `storagePath`).
 *   2. A firebasestorage.googleapis.com download URL whose /o/{object} segment
 *      decodes to a path under the same tenant prefix.
 */
/** The project's own Storage buckets - the modern default and the legacy
 *  appspot alias. A download URL naming any other bucket is another project's
 *  storage, however plausible its object key looks. */
const ALLOWED_STORAGE_BUCKETS = [
  'safentia-tech.firebasestorage.app',
  'safentia-tech.appspot.com',
] as const;

export function requireTenantStorageRef(
  value: string,
  field: string,
  env: Environment,
  orgId: string,
): string {
  const prefix = tenantStoragePrefix(env, orgId);

  // Form 1: a raw object path inside the tenant root.
  if (!value.includes('://') && value.startsWith(prefix)) {
    return value;
  }

  // Form 2: a Firebase Storage download URL. Parse strictly: https only, the
  // exact Firebase Storage host, and the object segment (URL-encoded after /o/)
  // must decode to a path under the caller's own tenant prefix.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw fail.invalidArgument(`The ${field} field is not a valid file reference.`, {
      field,
    });
  }
  // The BUCKET is pinned as well as the host: any Firebase project can host an
  // object whose key mimics our tenant prefix, so an unpinned bucket segment
  // would let an admin point org assets at attacker-controlled, mutable content
  // in a foreign project (tracking report opens, swapping imagery after review).
  const bucketAlternatives = ALLOWED_STORAGE_BUCKETS.map((bucket) =>
    bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|');
  const objectPattern = new RegExp(`^/v0/b/(?:${bucketAlternatives})/o/(.+)$`);
  const objectMatch =
    parsed.protocol === 'https:' &&
    parsed.hostname === 'firebasestorage.googleapis.com'
      ? objectPattern.exec(parsed.pathname)
      : null;
  if (objectMatch) {
    let objectPath: string;
    try {
      objectPath = decodeURIComponent(objectMatch[1]);
    } catch {
      throw fail.invalidArgument(
        `The ${field} field is not a valid file reference.`,
        { field },
      );
    }
    if (objectPath.startsWith(prefix)) {
      return value;
    }
  }

  throw fail.invalidArgument(
    `The ${field} field must reference a file stored by your organisation.`,
    { field },
  );
}
