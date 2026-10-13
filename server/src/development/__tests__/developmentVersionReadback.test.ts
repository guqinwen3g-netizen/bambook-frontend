import { describe, expect, it, vi } from 'vitest';
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: vi.fn(async () => ({ actor: { userId: 'sales' }, development: { id: 'case-1' } })) }));
import { createGarmentSampleGateService } from '../../samples/garmentSampleGateService';
import { listSampleBatches } from '../fabricDevelopmentService';

function fixture(type = 'garment') {
  const batch: any = { id: 'batch-a', developmentCaseId: 'case-1', sampleType: type === 'fabric' ? 'yardage' : 'garment-round', sampleVersionId: 'major-a', round: 1, versionLabel: 'R1-A', status: 'making', deletedAt: null, createdAt: 1n, updatedAt: 1n };
  const major: any = { id: 'major-a', developmentCaseId: 'case-1', versionLabel: 'R1-A', versionKind: 'major', roundId: 'round-1', supplierRelationId: 'factory-a', minorVersion: 0, deletedAt: null, updatedAt: 1n };
  const minor: any = { ...major, id: 'minor-a1', versionLabel: 'R1-A.1', versionKind: 'minor', parentVersionId: major.id, minorVersion: 1, minorChangeNote: '领宽微调，无新实物', createdAt: 1n };
  const review = { id: 'review-a', sampleBatchId: batch.id, sampleVersionId: major.id, developmentCaseId: 'case-1', reviewSequence: 1, status: 'reviewed', result: 'pass', reviewedAt: 2n, requestedAt: 1n, createdAt: 1n, updatedAt: 2n, sourceSnapshot: { versionLabel: major.versionLabel } };
  const confirmation = { id: 'confirmation-a', developmentCaseId: 'case-1', sampleVersionId: major.id, confirmerType: 'internal', confirmerName: '需求方', recordedBy: 'sales', confirmedAt: 2n, recordedAt: 3n, result: 'approved' };
  const prisma: any = {
    developmentCase: { findFirst: vi.fn(async () => ({ id: 'case-1', type, deletedAt: null })) },
    sampleBatch: { findMany: vi.fn(async () => [batch]) },
    developmentSampleRound: { findMany: vi.fn(async () => [{ id: 'round-1', round: 1, updatedAt: 1n }]) },
    developmentSampleVersion: { findMany: vi.fn(async ({ where }: any) => where.OR ? [major, minor] : where.parentVersionId ? [minor] : [major]) },
    developmentSampleQualityReview: { findMany: vi.fn(async ({ where }: any) => where.sampleVersionId === null ? [] : [review]) },
    developmentVersionConfirmation: { findMany: vi.fn(async () => [confirmation]) },
    productAsset: { findMany: vi.fn(async () => [{ id: 'asset-minor', sku: 'GR-MINOR', name: 'minor', sourceSampleVersionId: minor.id, sourceSampleBatchId: batch.id }]) },
  };
  return { prisma, batch, major, minor };
}

describe('existing development APIs read exact version workflow facts', () => {
  it('garment readback does not inherit parent QC, requester confirmation or a minor asset into the parent', async () => {
    const f = fixture();
    const result = await createGarmentSampleGateService({ prisma: f.prisma }).listRounds({ caseId: 'case-1' });
    expect(result).toMatchObject({ ok: true, data: { items: [{ sampleVersionId: 'major-a', latestFormalQcReview: { id: 'review-a', sampleVersionId: 'major-a', result: 'pass' }, versionConfirmation: { id: 'confirmation-a' }, linkedAsset: null,
      microVersions: [{ id: 'minor-a1', developmentQcReview: null, latestFormalQcReview: null, developmentQcHistory: [], versionConfirmation: null, linkedAsset: { id: 'asset-minor' } }] }] } });
  });
  it('fabric readback uses the exact major workflow and leaves its dotted version decisions empty', async () => {
    const f = fixture('fabric');
    expect(await listSampleBatches(f.prisma, 'case-1')).toMatchObject({ ok: true, data: { batches: [{ sampleVersionId: 'major-a', latestFormalQcReview: { id: 'review-a' }, versionConfirmation: { id: 'confirmation-a' },
      microVersions: [{ id: 'minor-a1', latestFormalQcReview: null, versionConfirmation: null }] }] } });
  });
});
