import { describe, expect, it, vi } from 'vitest';
import { createDevelopmentWorkspaceService } from '../developmentWorkspaceService';
import { DevelopmentDomainError } from '../developmentOperationalGuard';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), quality: vi.fn(), consumption: vi.fn(), decisions: vi.fn() }));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: mocks.authorize }));
vi.mock('../developmentVersionGate', () => ({ assertDevelopmentVersionQualityPass: mocks.quality, assertDevelopmentQualitySourceCurrent: vi.fn(async () => undefined),
  assertDevelopmentVersionReadyForConsumption: mocks.consumption, developmentVersionSnapshot: (row: any) => ({ id: row.id, versionKind: row.versionKind, parentVersionId: row.parentVersionId, factoryRequirements: row.factoryRequirements }),
  readDevelopmentVersionDecisions: mocks.decisions }));
const actor = { userId: 'sales', roles: [], permissions: ['products:read', 'products:write'] };
function fixture() {
  mocks.authorize.mockReset().mockResolvedValue({ actor }); mocks.quality.mockReset().mockRejectedValue(new DevelopmentDomainError('QC_PASS_REQUIRED', '本版尚无正式QC通过'));
  mocks.consumption.mockReset().mockRejectedValue(new DevelopmentDomainError('QC_PASS_REQUIRED', '本版尚无正式QC通过'));
  mocks.decisions.mockReset().mockResolvedValue(new Map());
  const versions = [{ id: 'major', versionKind: 'major', supplierRelationId: 'F', factoryRequirements: 'R1-A actual task' }, { id: 'minor', versionKind: 'minor', parentVersionId: 'major', supplierRelationId: 'F' }];
  const db = { developmentCase: { findFirst: vi.fn(async () => ({ id: 'C', type: 'fabric', stage: 'developing' })) },
    developmentSampleVersion: { findMany: vi.fn(async () => versions), findFirst: vi.fn(async ({ where }: any) => versions.find(row => row.id === where.id) ?? null) },
    sampleBatch: { findMany: vi.fn(async () => [{ id: 'B', sampleVersionId: 'major', supplierRelationId: 'F', returnedAt: '100', planQuantity: '1', planUnit: 'm' }]) },
    sampleCardItem: { findMany: vi.fn(async () => [{ id: 'physical', batchId: 'B' }]) }, developmentLifecycleEvent: { findFirst: vi.fn(async () => null) },
    productAsset: { findMany: vi.fn(async () => []) }, auditLog: { findMany: vi.fn(async () => []), create: vi.fn() } };
  return { db, service: createDevelopmentWorkspaceService({ prisma: db }) };
}
describe('development workspace exact version facts without read-side domain writes', () => {
  it('keeps the case tree unselected and rejects blank or foreign explicit version IDs', async () => {
    const f = fixture(), result = await f.service.read('C', actor);
    expect(result.scope).toEqual({ kind: 'development_case', caseId: 'C' }); expect(result.nodes.map(row => row.id)).toEqual(['tasks']);
    expect(f.db.sampleCardItem.findMany).not.toHaveBeenCalled(); expect(mocks.decisions).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
    await expect(f.service.read('C', actor, '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.service.read('C', actor, 'foreign')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('selects a minor own decisions while referencing only the original physical batch and leaving future areas closed', async () => {
    const f = fixture(), result = await f.service.read('C', actor, 'minor');
    expect(mocks.decisions).toHaveBeenCalledWith(f.db, 'C', ['minor']); expect(mocks.quality).toHaveBeenCalledWith(f.db, 'C', 'minor');
    expect(result.overview.physicalSampleVersionId).toBe('major');
    expect(result.nodes.find(row => row.id === 'qc')).toMatchObject({ canContinue: true, canOpen: false });
    expect(result.nodes.find(row => row.id === 'archive')).toMatchObject({ canContinue: false, canOpen: false });
    expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
});
