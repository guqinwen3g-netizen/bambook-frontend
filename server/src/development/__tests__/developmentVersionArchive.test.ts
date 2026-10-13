import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => 'archive-audit'), source: vi.fn(async () => undefined),
  physical: vi.fn(async () => ({ physicalCardId: 'card-1', physicalCardIds: ['card-1'] })),
  createAsset: vi.fn(async (_tx: any, _prefix: any, data: any) => ({ ...data, id: 'asset-new', sku: 'GR-1' })),
}));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));
vi.mock('../developmentOperationalGuard', async () => ({ ...await vi.importActual<any>('../developmentOperationalGuard'), assertDevelopmentOperationalWrite: vi.fn(async () => undefined) }));
vi.mock('../garmentSourceBindingService', () => ({ assertGarmentSourceAccess: vi.fn(async () => undefined), garmentRoundContent: () => ({}), garmentCaseContent: () => ({}) }));
vi.mock('../developmentSampleQualityService', () => ({ assertReviewSourceCurrent: mocks.source, listQualityReviewsByBatchIds: vi.fn(async () => new Map()) }));
vi.mock('../developmentPhysicalArchiveLink', () => ({ linkDevelopmentPhysicalSamplesToAsset: mocks.physical }));
vi.mock('../../products/developmentSkuAllocator', () => ({ createDevelopmentAssetWithSku: mocks.createAsset }));
vi.mock('../../entities/sync', () => ({ syncDevelopmentCaseReferences: vi.fn(async () => undefined) }));
import { convertToGarmentAsset } from '../garmentDevelopmentService';

function fixture() {
  const development: any = { id: 'case-1', code: 'DEV-1', type: 'garment', name: 'Shirt', customerRelationId: null, productAssetId: null, createdAt: 1n, updatedAt: 1n };
  const batch: any = { id: 'batch-1', developmentCaseId: development.id, sampleType: 'garment-round', supplierRelationId: 'factory-a', round: 1, sampleVersionId: 'major-a', versionLabel: 'R1-A', status: 'making', customerStatus: 'pending', returnedAt: 5n, deletedAt: null };
  const versions: any[] = [
    { id: 'major-a', developmentCaseId: development.id, supplierRelationId: 'factory-a', roundId: 'round-1', versionLabel: 'R1-A', versionKind: 'major', deletedAt: null },
    { id: 'minor-a1', developmentCaseId: development.id, supplierRelationId: 'factory-a', roundId: 'round-1', versionLabel: 'R1-A.1', versionKind: 'minor', parentVersionId: 'major-a', minorChangeNote: '领宽增加 0.5cm', deletedAt: null },
  ];
  const reports: any[] = [{ id: 'report-major', developmentCaseId: development.id, sampleVersionId: 'major-a', sampleBatchId: batch.id, reviewSequence: 1, status: 'reviewed', result: 'pass', reviewedBy: 'qc-1', reviewedAt: 10n }];
  const assets: any[] = [];
  const tx: any = { $queryRaw: vi.fn(async () => [{ id: batch.id }]), developmentCase: { findFirst: vi.fn(async () => development), update: vi.fn(async ({ data }: any) => ({ ...development, ...data })) },
    sampleBatch: { findFirst: vi.fn(async () => batch) }, developmentSampleVersion: { findFirst: vi.fn(async ({ where }: any) => versions.find(row => row.id === where.id) ?? null) },
    developmentSampleQualityReview: { findFirst: vi.fn(async ({ where }: any) => reports.filter(row => row.sampleVersionId === where.sampleVersionId && where.status.in.includes(row.status)).sort((a, b) => b.reviewSequence - a.reviewSequence)[0] ?? null) },
    productAsset: { findMany: vi.fn(async () => assets) }, garmentProfile: { create: vi.fn(async () => undefined) },
    auditLog: { findFirst: vi.fn(async ({ where }: any) => { const report = reports.find(row => row.id === where.targetId); return report ? { actorId: report.reviewedBy, detail: { after: { reportId: report.id, result: report.result, reviewedAt: String(report.reviewedAt), sampleVersionId: report.sampleVersionId, sourceFingerprint: report.sourceFingerprint } } } : null; }) },
  };
  const prisma: any = { developmentCase: tx.developmentCase, sampleBatch: tx.sampleBatch, $transaction: async (run: any) => run(tx) };
  const convert = (sourceVersionId: string) => convertToGarmentAsset({ prisma, caseId: development.id, sourceType: 'node', sourceId: 'confirmation', sourceRoundId: batch.id, sourceVersionId,
    actorId: 'sales', trustedActor: { userId: 'sales' } as any });
  return { development, batch, versions, reports, assets, tx, convert };
}

describe('existing garment archive endpoint uses accurate version decisions', () => {
  beforeEach(() => vi.clearAllMocks());
  it('allows a QC-passed major version before customer selection', async () => {
    const f = fixture();
    expect(await f.convert('major-a')).toMatchObject({ ok: true, data: { asset: { sourceSampleVersionId: 'major-a' } } });
    expect(mocks.createAsset).toHaveBeenCalledWith(f.tx, 'GR', expect.objectContaining({ sourceSpecSnapshot: expect.objectContaining({ physicalCardIds: ['card-1'] }) }));
  });
  it('rejects a dotted version that only has its parent pass', async () => {
    const f = fixture();
    expect(await f.convert('minor-a1')).toMatchObject({ ok: false, error: { code: 'QC_PASS_REQUIRED' } });
    expect(mocks.createAsset).not.toHaveBeenCalled();
  });
  it('archives the dotted version with its own pass and references the original physical piece', async () => {
    const f = fixture(); f.reports.push({ ...f.reports[0], id: 'report-minor', sampleVersionId: 'minor-a1' });
    expect(await f.convert('minor-a1')).toMatchObject({ ok: true, data: { asset: { sourceSampleVersionId: 'minor-a1', sourceVersionLabel: 'R1-A.1' } } });
    expect(mocks.physical).toHaveBeenCalledTimes(1);
    expect(mocks.physical).toHaveBeenCalledWith(f.tx, f.batch, f.development, expect.any(String), expect.any(BigInt), { referenceOnly: true });
    expect(f.tx.garmentProfile.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sampleVersion: 'R1-A.1' }) }));
  });
});
