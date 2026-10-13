import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authority: vi.fn(), current: vi.fn(async () => ({ userId: 'qc-1' })) }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: mocks.authority, currentConversionActor: mocks.current }));
import { listDevelopmentSampleQualityReviews } from '../developmentSampleQualityService';
import { DevelopmentDomainError } from '../developmentOperationalGuard';

function review(id: string, developmentCaseId: string) {
  return {
    id,
    developmentCaseId,
    sampleBatchId: `batch-${id}`,
    status: 'queued',
    requestedAt: 1n,
    startedAt: null,
    reviewedAt: null,
    acknowledgedAt: null,
    createdAt: 1n,
    updatedAt: 1n,
    sourceSnapshot: {
      case: { id: developmentCaseId, code: `DEV-${id}`, name: `开发案-${id}`, customerName: null, requirements: {} },
      round: 1,
      versionLabel: 'R1-A',
      supplierName: '工厂甲',
      sampleType: 'fit-sample',
      batchCode: `SB-${id}`,
      results: { defectCauses: [] },
      physicalItems: [],
    },
  };
}

describe('development sample QC list domain projection', () => {
  it('returns authoritative case types as read-only DTO fields without changing frozen source snapshots', async () => {
    const rows = [review('review-garment', 'case-garment'), review('review-fabric', 'case-fabric'), review('review-missing', 'case-missing')];
    const developmentCaseFindMany = vi.fn(async () => [
      { id: 'case-garment', type: 'garment' },
      { id: 'case-fabric', type: 'fabric' },
      { id: 'case-legacy', type: 'trim' },
    ]);
    const prisma: any = {
      developmentSampleQualityReview: { findMany: vi.fn(async () => rows) },
      developmentCase: { findMany: developmentCaseFindMany },
    };
    mocks.authority.mockImplementation(async (_db: any, _scalar: any, _actor: any, caseId: string) => {
      const development = (await developmentCaseFindMany()).find(row => row.id === caseId);
      if (!development) throw new DevelopmentDomainError('NOT_FOUND', '来源不可见');
      return { development };
    });
    const result = await listDevelopmentSampleQualityReviews({ prisma, trustedActor: { userId: 'qc-1' } as any });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.map(item => [item.id, item.developmentType])).toEqual([
      ['review-garment', 'garment'],
      ['review-fabric', 'fabric'],
    ]);
    expect(result.data.items[0].sourceSnapshot.case).not.toHaveProperty('type');
    expect(mocks.authority).toHaveBeenCalledWith(prisma, 'qc-1', expect.any(Object), 'case-fabric', { scope: 'qc:read', write: false });
  });
  it('filters another inaccessible case instead of exposing it to a generic qc:read account', async () => {
    mocks.authority.mockRejectedValue(new DevelopmentDomainError('NOT_FOUND', '来源不在当前范围'));
    const prisma: any = { developmentSampleQualityReview: { findMany: vi.fn(async () => [review('private', 'another-case')]) } };
    expect(await listDevelopmentSampleQualityReviews({ prisma, trustedActor: { userId: 'qc-1' } as any })).toMatchObject({ ok: true, data: { items: [] } });
  });
});
