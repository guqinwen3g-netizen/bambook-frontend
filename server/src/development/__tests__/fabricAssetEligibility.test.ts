import { describe, expect, it, vi } from 'vitest';
import { assertFabricAssetEligible, lockConfirmedFabricSources, lockConfirmedFabricSourcesIsolated } from '../fabricAssetEligibility';
import { fabricBatchSnapshot } from '../fabricBatchHistory';

/** Storage-only round/history seam. Native approval+conversion proof is in the
 * opt-in PG probe; these fixtures are not company approval evidence. */
export function assetFixture() {
  const state: any = {
    asset: { id: 'asset', sku: 'SKU', name: 'Standalone label is irrelevant', deletedAt: null },
    devCase: { id: 'case', type: 'fabric', stage: 'approved', productAssetId: 'asset', deletedAt: null },
    batch: { id: 'batch', developmentCaseId: 'case', status: 'approved', sampleType: 'lab-dip', round: 1,
      customerStatus: 'approved', approvedBy: 'leader', approvedAt: BigInt(1), convertedProductAssetId: 'asset', convertedAt: BigInt(2), deletedAt: null },
    audits: [] as any[], seals: [] as any[], links: [] as any[], standalone: false,
  };
  const approved = { ...fabricBatchSnapshot(state.batch), convertedProductAssetId: null, convertedAt: null };
  const conversion = { id: 'event-convert', kind: 'convert', round: 1, actorId: 'leader', auditId: 'audit-convert',
    before: approved, after: fabricBatchSnapshot(state.batch) };
  const approval = { id: 'event-approve', kind: 'approve', round: 1, actorId: 'leader', auditId: 'audit-approve', before: {}, after: approved };
  state.batch.attachments = { fabricHistory: { schemaVersion: 1, revision: 2, events: [approval, conversion] } };
  state.audits.push({ id: 'audit-approve', actorId: 'leader', action: 'advance_sample_batch', targetType: 'SampleBatch', targetId: 'batch', detail: { after: { roundFact: { kind: 'approve', before: {}, after: approved } } } },
    { id: 'audit-convert', actorId: 'leader', action: 'convert_fabric_to_asset', targetType: 'ProductAsset', targetId: 'asset',
      detail: { source: 'route:dev:fabric-convert-asset', after: { fromCase: 'case', sourceType: 'batch', sourceId: 'batch', roundFact: { kind: 'convert', before: conversion.before, after: conversion.after } } } });
  state.audits = state.audits.map((row: any) => ({ ...row, detail: JSON.parse(JSON.stringify(row.detail)) }));
  const db: any = {
    auditLog: { findMany: vi.fn(async ({ where }: any) => state.audits.filter((row: any) => row.action === where.action && row.targetType === where.targetType && row.targetId === where.targetId)),
      findFirst: vi.fn(async ({ where }: any) => state.audits.find((row: any) => Object.entries(where).every(([field, value]) => row[field] === value)) ?? null) },
    productAsset: { findUnique: vi.fn(async ({ where }: any) => (where.id === state.asset.id || where.sku === state.asset.sku) ? state.asset : null) },
    developmentCase: { findMany: vi.fn(async () => state.standalone ? [] : [state.devCase]), findFirst: vi.fn(async ({ where }: any) => !state.devCase.deletedAt && where.id === state.devCase.id ? state.devCase : null) },
    sampleBatch: { findMany: vi.fn(async () => state.standalone ? [] : [state.batch]), findFirst: vi.fn(async ({ where }: any) => where.id === state.batch.id && !state.batch.deletedAt ? state.batch : null) },
    sealSample: { findMany: vi.fn(async () => state.seals), findFirst: vi.fn(async ({ where }: any) => state.seals.find((row: any) => row.id === where.id && !row.deletedAt) ?? null) },
    sealSampleBatch: { findMany: vi.fn(async () => state.links) },
    sampleSource: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
  };
  return { db, state };
}

describe('Fabric asset consumers retain provenance and recheck current permission', () => {
  it('legacy approved round and conversion audit remain historical without inventing an exact version', async () => {
    const f = assetFixture(); await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    expect(f.state.batch.status).toBe('approved'); expect(f.state.audits).toHaveLength(2);
  });
  it.each(['needs_recast', 'rejected'])('current customer %s cannot reuse original approval/asset', async status => {
    const f = assetFixture(); f.state.batch.customerStatus = status;
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    expect(f.state.audits).toHaveLength(2); expect(f.state.batch.attachments.fabricHistory.events).toHaveLength(2);
  });
  it('an old asset is still a development asset after its current pointer is replaced', async () => {
    const f = assetFixture(); f.state.batch.convertedProductAssetId = 'new-asset'; f.state.devCase.productAssetId = 'new-asset';
    // Reverse pointer lookup alone returns no rows; exact old target audit must still bind.
    f.db.sampleBatch.findMany.mockResolvedValue([]); f.db.developmentCase.findMany.mockResolvedValue([]);
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('native conversion must be after the current approval in the same round', async () => {
    const f = assetFixture(); f.state.batch.round = 2;
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('recorded development linkage without its conversion audit fails closed', async () => {
    const f = assetFixture(); f.state.audits = [];
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('corrupt history/approval audit cannot be replaced by approved status', async () => {
    const f = assetFixture(); f.state.audits[0].detail.after.roundFact.after.customerStatus = 'rejected';
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('independent manual asset remains valid even with a development-like label', async () => {
    const f = assetFixture(); f.state.standalone = true; f.state.audits = []; f.state.asset.source = 'development';
    await expect(assertFabricAssetEligible(f.db, 'asset')).resolves.toEqual({ source: null });
  });
  it('deleted source and duplicate conversion provenance reject without history writes', async () => {
    const f = assetFixture(); f.state.batch.deletedAt = BigInt(3);
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    f.state.batch.deletedAt = null; f.state.audits.push({ ...f.state.audits[1], id: 'duplicate' });
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
  });
  it('writes lock DevelopmentCase→Batch→Asset before any consumer parent', async () => {
    const f = assetFixture(); await lockConfirmedFabricSources(f.db, [{ type: 'Asset', id: 'asset' }]);
    expect(f.db.$queryRaw.mock.calls.map(([sql]: any) => sql.sql.match(/FROM "(\w+)"/)[1])).toEqual(['DevelopmentCase', 'SampleBatch', 'ProductAsset']);
  });
  it.each([lockConfirmedFabricSources, lockConfirmedFabricSourcesIsolated])('an asset-only Sample locks its product before the sample, matching the sample editor (%#)', async lockSources => {
    const f = assetFixture();
    f.db.sample = { findFirst: vi.fn().mockResolvedValue({ id: 'sample', sourceCaseId: null, sourceOrderId: 'source-order', productAssetId: 'asset' }) };
    await lockSources(f.db, [{ type: 'Sample', id: 'sample' }], { orderIds: ['target-order', 'source-order'] });
    const locks = f.db.$queryRaw.mock.calls.map(([sql]: any) => ({ table: sql.sql.match(/FROM "(\w+)"/)[1], id: sql.values[0] }));
    expect(locks).toEqual([
      { table: 'DevelopmentCase', id: 'case' }, { table: 'SampleBatch', id: 'batch' },
      { table: 'Order', id: 'source-order' }, { table: 'Order', id: 'target-order' },
      { table: 'ProductAsset', id: 'asset' }, { table: 'Sample', id: 'sample' },
    ]);
  });
  it('changing a sample source order while locking refuses the stale discovered parent set', async () => {
    const f = assetFixture();
    f.db.sample = { findFirst: vi.fn()
      .mockResolvedValueOnce({ id: 'sample', sourceCaseId: null, sourceOrderId: 'before', productAssetId: null })
      .mockResolvedValueOnce({ id: 'sample', sourceCaseId: null, sourceOrderId: 'after', productAssetId: null }) };
    await expect(lockConfirmedFabricSources(f.db, [{ type: 'Sample', id: 'sample' }])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.db.$queryRaw.mock.calls.map(([sql]: any) => sql.values[0])).toEqual(['before', 'sample']);
  });
  it('locks a sample’s exact origin parents even when its legacy header has no case or asset', async () => {
    const f = assetFixture();
    const originBatch = { id: 'origin-batch', caseId: 'origin-case', developmentCaseId: 'origin-case', deletedAt: null };
    f.db.sampleBatch.findMany.mockImplementation(async ({ where }: any) =>
      where.id?.in?.includes(originBatch.id) ? [originBatch] : []);
    f.db.sample = { findFirst: vi.fn().mockResolvedValue({ id: 'sample', sourceCaseId: null, productAssetId: null }) };
    f.db.sampleSource.findMany.mockResolvedValue([{ id: 'origin', sampleId: 'sample', sampleBatchId: 'origin-batch', sourceRound: 1,
      sourceSnapshot: { batch: { caseId: 'origin-case' } }, sourceUpdatedAt: BigInt(1) }]);
    await lockConfirmedFabricSources(f.db, [{ type: 'Sample', id: 'sample' }]);
    expect(f.db.$queryRaw.mock.calls.map(([sql]: any) => [sql.sql.match(/FROM "(\w+)"/)[1], sql.values[0]])).toEqual([
      ['DevelopmentCase', 'origin-case'], ['SampleBatch', 'origin-batch'], ['Sample', 'sample'],
    ]);
  });
  it('a changed origin round on the same parent IDs cannot evade locked-source rereading', async () => {
    const f = assetFixture();
    const binding = { id: 'origin', sampleId: 'sample', sampleBatchId: 'origin-batch', sourceRound: 1,
      sourceSnapshot: { batch: { caseId: 'origin-case' } }, sourceUpdatedAt: BigInt(1) };
    f.db.sample = { findFirst: vi.fn().mockResolvedValue({ id: 'sample', sourceCaseId: null, productAssetId: null }) };
    f.db.sampleSource.findMany.mockResolvedValue([binding]);
    f.db.$queryRaw.mockImplementation(async () => { binding.sourceRound = 2; return [{ id: 'locked' }]; });
    await expect(lockConfirmedFabricSources(f.db, [{ type: 'Sample', id: 'sample' }])).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('SQL dependency failure is not mistaken for legitimate standalone absence', async () => {
    const f = assetFixture(), fault = Object.assign(new Error('synthetic SQL failure'), { code: 'P2022' }); f.db.auditLog.findMany.mockRejectedValue(fault);
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toBe(fault);
  });
});
