// ============================================================================
// manageBuildingDocument (callable, admin-only) - Phase 2 admin, documents.
//
// Create or remove a building document record (/documents/{orgId}/{buildingId}/
// {category}/{docId}). The file itself is already in tenant-scoped Storage
// (uploaded under the Storage rules); this manages the RTDB record that points
// at it. Every change lands in the SAME multi-location update as its /activity
// entry, so the audit trail cannot be skipped or forged - the whole reason this
// is a callable. The record's file pointer is `storagePath` (the SafentiaDocument
// shape), which gets the same tenant-boundary validation as the org logo: it
// must sit inside this org's own Storage root, never another tenant's.
// uploadedBy/uploadedAt are stamped server-side from the verified caller, never
// trusted from the client, so attribution cannot be forged.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireString,
  optionalString,
  requireEnum,
  requireTenantStorageRef,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { DOCUMENT_CATEGORIES } from '../shared/types';
import type {
  ManageBuildingDocumentInput,
  ManageBuildingDocumentResult,
  SafentiaDocument,
} from '../shared/types';

/** The document fields an admin may supply; uploadedBy/uploadedAt are stamped
 *  server-side, so their presence in the payload is rejected, never trusted. */
const DOCUMENT_FIELDS = ['fileName', 'description', 'storagePath'] as const;

const ACTIONS = ['create', 'remove'] as const;

export const manageBuildingDocument = onCall<ManageBuildingDocumentInput>(
  callableOptions,
  (request) =>
    runCallable<ManageBuildingDocumentResult>(
      createLogger({ fn: 'manageBuildingDocument' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'manageBuildingDocument');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the action, the owning building and the category (the
        // category is a path segment, so the allow-list check also keeps the
        // write inside the schema's known children).
        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);
        const buildingId = requireString(input, 'buildingId', TEXT_LIMITS.shortText);
        const category = requireEnum(input, 'category', DOCUMENT_CATEGORIES);

        // 3a. Create: a record is a file name plus the tenant Storage path the
        // uploaded file lives at.
        if (action === 'create') {
          const payload = assertObject(input.document);
          for (const key of Object.keys(payload)) {
            if (!(DOCUMENT_FIELDS as readonly string[]).includes(key)) {
              throw fail.invalidArgument(`Unknown document field: ${key}.`, {
                field: key,
              });
            }
            // Null is the CLEAR intent in the update contracts (ClearableFields);
            // a document record is only ever created or removed, so null is a
            // client error here, never accepted.
            if (payload[key] === null) {
              throw fail.invalidArgument(
                `The ${key} field cannot be null when creating a document.`,
                { field: key },
              );
            }
          }
          const fileName = requireString(payload, 'fileName', TEXT_LIMITS.shortText);
          // Tenant boundary: the file must be an object this org uploaded.
          const storagePath = requireTenantStorageRef(
            requireString(payload, 'storagePath', 2048),
            'storagePath',
            env,
            orgId,
          );
          const description = optionalString(
            payload,
            'description',
            TEXT_LIMITS.freeText,
          );
          const document: SafentiaDocument = {
            fileName,
            storagePath,
            uploadedBy: uid,
            uploadedAt: Date.now(),
            ...(description ? { description } : {}),
          };
          const docId = db
            .ref(paths.db.documents(orgId, buildingId, category))
            .push().key as string;
          await db.ref().update({
            [paths.db.document(orgId, buildingId, category, docId)]: document,
            ...activityUpdate(paths, orgId, {
              actorUid: uid,
              action: `document.created (${category})`,
              target: docId,
            }),
          });
          createLogger({ fn: 'manageBuildingDocument', orgId }).info(
            'Document record created',
            { buildingId, category, docId },
          );
          return { docId };
        }

        // 3b. Remove: the record must exist; delete it with its audit entry.
        const docId = requireString(input, 'docId', TEXT_LIMITS.shortText);
        const docPath = paths.db.document(orgId, buildingId, category, docId);
        const existingSnap = await db.ref(docPath).get();
        if (!existingSnap.exists()) {
          throw fail.notFound('That document could not be found.', {
            field: 'docId',
          });
        }
        await db.ref().update({
          [docPath]: null,
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: `document.removed (${category})`,
            target: docId,
          }),
        });

        createLogger({ fn: 'manageBuildingDocument', orgId }).info(
          'Document record removed',
          { buildingId, category, docId },
        );
        return { docId };
      },
    ),
);
