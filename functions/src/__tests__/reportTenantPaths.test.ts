// ============================================================================
// Report tenant boundary (security fix): the Admin SDK ignores Storage rules,
// and several image / certificate references are client-written, so the report
// core must refuse to fetch any object outside `{env}/orgs/{orgId}/`.
//   - assembleReport -> resolveImage: a foreign logo/photo degrades to
//     "unavailable" and is NEVER downloaded; an in-tenant one is.
//   - loadCertificate: a foreign certificate is skipped before any Storage call.
// ============================================================================

const mockDbData: Record<string, unknown> = {};
const mockFileCalls: string[] = [];

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({
        exists: () => path in mockDbData,
        val: () => (path in mockDbData ? mockDbData[path] : null),
      }),
    }),
  },
  storage: {
    bucket: () => ({
      file: (objectPath: string) => {
        mockFileCalls.push(objectPath);
        return {
          download: async () => [Buffer.from('img')],
          getMetadata: async () => [{ size: 10 }],
        };
      },
    }),
  },
}));

import { assembleReport } from '../report/assemble';
import { loadCertificate } from '../report/certificate';
import { forEnv } from '../lib/paths';
import type { Logger } from '../lib/logging';

const ORG = 'orgA';
const ASMT = 'job-j1';
const env = forEnv('live');

const logger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => logger,
} as unknown as Logger;

const seed = (nodes: Record<string, unknown>) => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  Object.assign(mockDbData, nodes);
  mockFileCalls.length = 0;
};

describe('assembleReport refuses foreign-tenant images', () => {
  it('a foreign-org logo is unavailable and never downloaded; an in-tenant photo is fetched', async () => {
    seed({
      [env.db.assessment(ORG, ASMT)]: {
        jobId: 'j1',
        buildingId: 'b1',
        customerId: 'c1',
        status: 'released',
        templateSnapshot: { name: 'T', version: 1, sections: [] },
      },
      [env.db.job(ORG, 'j1')]: { siteId: 's1', buildingId: 'b1', customerId: 'c1' },
      [env.db.building(ORG, 's1', 'b1')]: {
        name: 'B1',
        customerId: 'c1',
        photoUrl: 'live/orgs/orgA/buildings/b1/photos/p1',
      },
      [env.db.orgProfile(ORG)]: {
        name: 'Org A',
        brand: { primary: '#000000', secondary: '#111111' },
        logoUrl: 'gs://bucket/live/orgs/orgB/assets/logo.png',
        coverImageUrl: 'test/orgs/orgA/assets/cover.png',
      },
    });

    const model = await assembleReport(env, ORG, ASMT, logger);

    // Neither the foreign-org logo nor the wrong-environment cover was touched.
    expect(mockFileCalls).not.toContain('live/orgs/orgB/assets/logo.png');
    expect(mockFileCalls).not.toContain('test/orgs/orgA/assets/cover.png');
    expect(mockFileCalls.every((p) => p.startsWith('live/orgs/orgA/'))).toBe(true);
    // The in-tenant building photo WAS fetched and embedded.
    expect(mockFileCalls).toContain('live/orgs/orgA/buildings/b1/photos/p1');
    expect(model.buildingPhoto?.available).toBe(true);
    // Any foreign reference surfaced degrades to "unavailable", never data.
    if (model.logo) {
      expect(model.logo.available).toBe(false);
      expect((model.logo as { data?: unknown }).data).toBeUndefined();
    }
    if (model.coverImage) {
      expect(model.coverImage.available).toBe(false);
    }
  });
});

describe('loadCertificate refuses foreign-tenant objects', () => {
  const tenant = 'live/orgs/orgA/';

  it.each([
    ['another org (bare path)', 'live/orgs/orgB/assets/certificates/c.pdf'],
    ['another org (gs://)', 'gs://bucket/live/orgs/orgB/assets/certificates/c.pdf'],
    [
      'another org (download URL)',
      'https://firebasestorage.googleapis.com/v0/b/bucket/o/live%2Forgs%2ForgB%2Fassets%2Fcertificates%2Fc.pdf?alt=media',
    ],
    ['the other environment', 'test/orgs/orgA/assets/certificates/c.pdf'],
    ['a platform object outside any org', 'backups/2026-10-01/dump.json'],
    ['an org-id prefix collision', 'live/orgs/orgA2/assets/certificates/c.pdf'],
  ])('skips %s without any Storage call', async (_label, url) => {
    mockFileCalls.length = 0;
    const result = await loadCertificate({ url } as never, tenant, logger);
    expect(result).toBeUndefined();
    expect(mockFileCalls).toHaveLength(0);
  });

  it('does reach Storage for an in-tenant certificate', async () => {
    mockFileCalls.length = 0;
    // The bytes are not a valid PDF, so the load itself degrades - the point is
    // only that the tenant gate lets an own-org object through to Storage.
    await loadCertificate(
      { url: 'live/orgs/orgA/assets/certificates/c.pdf' } as never,
      tenant,
      logger,
    ).catch(() => undefined);
    expect(mockFileCalls).toEqual(['live/orgs/orgA/assets/certificates/c.pdf']);
  });
});
