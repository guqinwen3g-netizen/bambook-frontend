import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ serial: 0, review: {} as any, version: {} as any }));
vi.mock('../developmentOperationalGuard', async () => ({ ...await vi.importActual<any>('../developmentOperationalGuard'), assertDevelopmentOperationalWrite: vi.fn(async () => undefined) }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: vi.fn(async () => undefined) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'audit') }));
vi.mock('../../shared/businessNumberService', () => ({ nextBusinessNumber: vi.fn(async () => `SB-${++mocks.serial}`) }));
vi.mock('../../entities/sync', () => ({ syncDevelopmentCaseReferences: vi.fn(async () => undefined) }));
vi.mock('../developmentPhysicalArchiveLink', () => ({ findDevelopmentFabricVersionAsset: vi.fn(async () => null), linkDevelopmentPhysicalSamplesToAsset: vi.fn(async () => ({ physicalCardId: 'card-1', physicalCardIds: ['card-1'] })) }));
vi.mock('../developmentSampleQualityService', () => ({ assertReviewSourceCurrent: vi.fn(async () => undefined) }));
vi.mock('../developmentVersionGate', async () => ({ ...await vi.importActual<any>('../developmentVersionGate'),
  resolveDevelopmentVersionForBatch: vi.fn(async () => ({ version: mocks.version })),
  assertDevelopmentVersionQualityPass: vi.fn(async () => mocks.review), readDevelopmentArchiveReceipt: vi.fn(async () => null), recordDevelopmentArchiveReceipt: vi.fn(async () => null),
}));
vi.mock('../../products/developmentSkuAllocator', () => ({ createDevelopmentAssetWithSku: vi.fn(async (_tx, _prefix, data) => ({ ...data, id: 'asset-1', sku: 'FB-1' })) }));
import { createSampleBatch, convertToFabricAsset } from '../fabricDevelopmentService';

describe('new physical fabric versions', () => {
  it('creates one version for selected forms, permits another physical sample in the same round and branches from an old version', async () => {
    const versions: any[] = [], rounds: any[] = [], batches: any[] = [];
    const development = { id: 'case-1', type: 'fabric', deletedAt: null };
    const tx: any = { $queryRaw: vi.fn(async () => [{ id: development.id }]),
      developmentCase: { findFirst: vi.fn(async () => development) },
      developmentSupplier: { findFirst: vi.fn(async () => ({ id: 'supplier' })) },
      developmentSampleRound: { findFirst: vi.fn(async ({ where }) => rounds.find(r => r.round === where.round) ?? null), create: vi.fn(async ({ data }) => { rounds.push(data); return data; }) },
      developmentSampleVersion: { findMany: vi.fn(async () => versions), create: vi.fn(async ({ data }) => { versions.push(data); return data; }) },
      sampleBatch: { findMany: vi.fn(async () => batches), create: vi.fn(async ({ data }) => { batches.push(data); return data; }) },
    };
    const prisma: any = { developmentCase: tx.developmentCase, $transaction: async run => run(tx) };
    const create = (round: number, supplierRelationId: string, sourceVersionId?: string) => createSampleBatch({ prisma, caseId: development.id, actorId: 'sales',
      input: { round, supplierRelationId, sourceVersionId, sampleTypes: ['lab-dip', 'yardage'] } });
    expect((await create(1, 'factory-a')).ok).toBe(true);
    expect(batches[0].sampleVersionId).toBe(batches[1].sampleVersionId);
    const old = versions[0].id;
    expect((await create(1, 'factory-a', old)).ok).toBe(true);
    expect((await create(2, 'factory-b')).ok).toBe(true);
    expect((await create(2, 'factory-a', old)).ok).toBe(true);
    expect(versions.map(row => row.versionLabel)).toEqual(['R1-A-1', 'R1-A-2', 'R2-B-1', 'R2-A-3']);
    expect(versions[3].sourceVersionId).toBe(old);
    expect(batches).toHaveLength(8);
    expect((await create(3, 'factory-b', old))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('archives conditional issues and actual evidence without manufacturing measured specifications from targets', async () => {
    const development = { id: 'case-1', code: 'DEV-1', name: 'Fabric', type: 'fabric', deletedAt: null,
      specWeight: '180', specWidth: '150cm', specWeave: 'Target twill', specFinish: 'Target finish', moqEstimate: 2000 };
    const batch = { id: 'batch-1', developmentCaseId: development.id, supplierRelationId: 'factory-a', sampleVersionId: 'version-1', sampleType: 'yardage', round: 1, status: 'making', deletedAt: null };
    mocks.version = { id: 'version-1', versionKind: 'minor', versionLabel: 'R1-A-1.1' };
    mocks.review = { id: 'review-1', result: 'conditional_pass', opinion: '实际克重偏重，客户须知悉', evidence: [{ id: 'report-file' }],
      sourceSnapshot: { case: { requirements: { specWeight: '180', specWidth: '150cm' } }, results: { notes: '实测信息见原报告', photos: ['sample-photo'] } } };
    const tx: any = { $queryRaw: vi.fn(async () => [batch]), sampleBatch: { findFirst: vi.fn(async () => batch) },
      developmentCase: { findFirst: vi.fn(async () => development), update: vi.fn(async ({ data }) => ({ ...development, ...data })) },
      fabricProfile: { create: vi.fn(async ({ data }) => data) },
    };
    const prisma: any = { developmentCase: tx.developmentCase, sampleBatch: tx.sampleBatch, $transaction: async run => run(tx) };
    const result = await convertToFabricAsset({ prisma, caseId: development.id, sourceType: 'batch', sourceId: batch.id, sourceVersionId: mocks.version.id, actorId: 'sales' });
    expect(result).toMatchObject({ ok: true, data: { asset: { imageUrl: 'sample-photo', sourceSpecSnapshot: { qualityResult: 'conditional_pass', qualityOpinion: mocks.review.opinion,
      qualityEvidence: mocks.review.evidence, actualResults: mocks.review.sourceSnapshot.results, targetRequirements: mocks.review.sourceSnapshot.case.requirements } } } });
    expect(tx.fabricProfile.create).toHaveBeenCalledWith({ data: expect.objectContaining({ construction: null, weightValue: null, weightUnit: null, widthValue: null, widthUnit: null, widthText: null, moqValue: null, specialNote: null }) });
  });
});
