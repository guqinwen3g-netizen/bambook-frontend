import { Prisma } from '@prisma/client';
import { productionBatchSourceFingerprint } from '../productionBatchService';
import { describe, expect, it, vi } from 'vitest';
import { advanceStage, PRODUCTION_STAGES } from '../stageService';
import { evaluateProductionRelease, summarizeOrderReleases } from '../releaseService';

function fixture(customerStatus = 'needs_recast') {
  const asset = { id: 'asset', sku: 'FAB', mainCategory: 'fabric', fabricProfile: { millOrganizationId: 'mill' }, deletedAt: null };
  const order = { id: 'order', millRelationId: 'mill', customerRelationId: null, sourceCaseId: null, deletedAt: null };
  const batch = { id: 'batch', developmentCaseId: 'case', supplierRelationId: 'mill', status: 'approved', sampleType: 'lab-dip', round: 1,
    customerStatus, approvedAt: BigInt(1), approvedBy: 'leader', convertedProductAssetId: asset.id, deletedAt: null };
  const line = { id: 'line', orderId: 'order', quantity: '100', unit: 'M', confirmedSourceType: 'Asset', confirmedSourceId: asset.id, specSnapshot: { sku: 'FAB' } };
  const scope = { id: 'scope', orderId: 'order', orderLineId: line.id, quantity: '100', unit: 'M', productionBatchId: 'human-stable-split', productionBatchRevision: 1, factoryRelationId: 'mill', state: 'ready',
    confirmedSourceType: 'Asset', confirmedSourceId: asset.id, scopeRevision: 1, specSnapshot: line.specSnapshot, currentReleaseId: 'release', deletedAt: null };
  // Complete substituted native storage identity. No production SQL or real
  // approval is claimed by this unit fixture; native producers prove that seam.
  const physical = { id: scope.productionBatchId, orderId: order.id, orderLineId: line.id, state: 'active', revision: 1,
    rangeStart: new Prisma.Decimal('0'), quantity: new Prisma.Decimal('100'), unit: line.unit, factoryRelationId: 'mill',
    confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot,
    sourceFingerprint: productionBatchSourceFingerprint(order, line, 'mill') };
  const binding = { schemaVersion: 1, id: physical.id, orderId: order.id, orderLineId: line.id, revision: 1,
    rangeStart: '0', quantity: '100', unit: line.unit, factoryRelationId: 'mill', confirmedSourceType: line.confirmedSourceType,
    confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot, sourceFingerprint: physical.sourceFingerprint };
  const evidenceSnapshot = { productionBatchBinding: binding };
  const release = { id: 'release', requestId: 'request', scopeId: scope.id, scopeRevision: 1, sampleId: null, evidenceSnapshot };
  const state = { scope, release, events: [] as any[], audits: [] as any[], stage: { id: 'stage', orderId: 'order', stageKey: 'manufacturing', stageSeq: 8, status: 'pending', doneAt: null, signedByBusiness: 'leader' } };
  const tx: any = {
    order: { findFirst: vi.fn(async () => order) },
    productionBatch: { findFirst: vi.fn(async ({ where }: any) => where.id === physical.id && where.orderId === order.id && where.orderLineId === line.id ? physical : null),
      findUnique: vi.fn(async ({ where }: any) => where.id === physical.id ? physical : null) },
    orderLine: { findMany: vi.fn(async () => [line]), findUnique: vi.fn(async () => line) },
    releaseScope: { findMany: vi.fn(async () => [scope]), findFirst: vi.fn(async () => scope), update: vi.fn(async ({ data }: any) => Object.assign(scope, data)) },
    ppSampleRelease: { findUnique: vi.fn(async () => release), findMany: vi.fn(async () => [release]) },
    releaseRequest: { findUnique: vi.fn(async () => ({ id: 'request', state: 'granted', scopeId: 'scope', scopeRevision: 1, specSnapshot: line.specSnapshot, evidenceSnapshot })) },
    releaseEvent: { findFirst: vi.fn(async () => state.events.at(-1) ?? null), create: vi.fn(async ({ data }: any) => { state.events.push(data); return data; }) },
    developmentCase: { findMany: vi.fn(async () => [{ id: 'case', type: 'fabric', productAssetId: 'asset' }]), findFirst: vi.fn(async () => ({ id: 'case', type: 'fabric', stage: 'approved' })) },
    sampleBatch: { findMany: vi.fn(async () => [batch]), findFirst: vi.fn(async () => batch) },
    sealSample: { findMany: vi.fn(async () => []) }, sealSampleBatch: { findMany: vi.fn(async () => []) },
    productAsset: { findUnique: vi.fn(async () => asset) },
    auditLog: { findMany: vi.fn(async () => [{ id: 'conversion', actorId: 'leader', detail: { source: 'route:dev:fabric-convert-asset', after: { fromCase: 'case', sourceType: 'batch', sourceId: 'batch' } } }]),
      create: vi.fn(async ({ data }: any) => { state.audits.push(data); return data; }) },
    productionStage: { findUnique: vi.fn(async () => state.stage), findMany: vi.fn(async () => PRODUCTION_STAGES.filter(item => item.seq < state.stage.stageSeq).map(item => ({ ...item, stageKey: item.key, status: 'done' }))),
      update: vi.fn(async ({ data }: any) => Object.assign(state.stage, data)), findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => [{ id: 'lock' }]),
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  return { prisma, tx, state, batch, line };
}

describe('Fabric asset eligibility is consumed by current production gates', () => {
  it('evaluate/summary do not count stale ready and have no invalidation side effect', async () => {
    const f = fixture(), original = { ...f.state.release };
    expect(await evaluateProductionRelease({ prisma: f.prisma, scopeId: 'scope' })).toMatchObject({ ok: true, data: { eligible: false } });
    expect(await summarizeOrderReleases({ prisma: f.prisma, orderId: 'order' })).toMatchObject({ ok: true, data: { ready: 0, blocked: 1 } });
    expect(f.state.scope.state).toBe('ready'); expect(f.state.events).toEqual([]); expect(f.state.release).toEqual(original);
  });
  it.each(['manufacturing', 'pp_sample_approved'] as const)('%s rejects ownerOverride and commits explicit invalidation while preserving old release', async stageKey => {
    const f = fixture(); Object.assign(f.state.stage, { stageKey, stageSeq: stageKey === 'manufacturing' ? 8 : 7 }); const original = { ...f.state.release };
    const result = await advanceStage({ prisma: f.prisma, orderId: 'order', stageKey, operator: 'leader', ownerOverride: { reason: 'urgent' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } });
    expect(f.tx.productionStage.update).not.toHaveBeenCalled(); expect(f.state.stage.status).toBe('pending');
    expect(f.state.scope).toMatchObject({ state: 'invalidated', currentReleaseId: 'release' }); expect(f.state.release).toEqual(original);
    expect(f.state.events).toEqual([expect.objectContaining({ kind: 'invalidated', releaseId: 'release' })]);
    expect(f.state.audits).toEqual([expect.objectContaining({ action: 'invalidate_release_source' })]);
    await advanceStage({ prisma: f.prisma, orderId: 'order', stageKey, operator: 'leader', ownerOverride: { reason: 'again' } });
    expect(f.state.events).toHaveLength(1);
  });
  it('valid current asset and legitimate manual split can advance without an invented batch model', async () => {
    const f = fixture('approved');
    expect(await advanceStage({ prisma: f.prisma, orderId: 'order', stageKey: 'manufacturing', operator: 'leader' })).toMatchObject({ ok: true });
    expect(f.state.stage.status).toBe('done'); expect(f.state.events).toEqual([]);
  });
  it('an original request without granted status cannot qualify the release', async () => {
    const f = fixture('approved');
    f.tx.releaseRequest.findUnique.mockResolvedValue({ id: 'request', scopeId: 'scope', scopeRevision: 1, specSnapshot: f.line.specSnapshot });
    expect(await evaluateProductionRelease({ prisma: f.prisma, scopeId: 'scope' })).toMatchObject({ ok: true, data: { eligible: false } });
    expect(await advanceStage({ prisma: f.prisma, orderId: 'order', stageKey: 'manufacturing', operator: 'leader' })).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } });
    expect(f.tx.productionStage.update).not.toHaveBeenCalled();
  });
  it('scope/line confirmed-source drift blocks ready projection', async () => {
    const f = fixture('approved'); f.line.confirmedSourceId = 'other-asset';
    expect(await evaluateProductionRelease({ prisma: f.prisma, scopeId: 'scope' })).toMatchObject({ ok: true, data: { eligible: false } });
  });
  it('current source mill mismatch cannot qualify the original scope factory', async () => {
    const f = fixture('approved'); Object.assign(f.state.scope, { factoryRelationId: 'other-mill' });
    expect(await evaluateProductionRelease({ prisma: f.prisma, scopeId: 'scope' })).toMatchObject({ ok: true, data: { eligible: false } });
  });
  it('dependency read failure is a safe service error, not empty eligible evidence', async () => {
    const f = fixture('approved'); f.tx.auditLog.findMany.mockRejectedValue(Object.assign(new Error('SQL internal bytes'), { code: 'P2022' }));
    const result = await evaluateProductionRelease({ prisma: f.prisma, scopeId: 'scope' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', status: 500 } }); expect(JSON.stringify(result)).not.toContain('SQL internal bytes');
    expect(f.state.events).toEqual([]); expect(f.state.scope.state).toBe('ready');
  });
  it('mandatory invalidation audit failure does not advance the stage', async () => {
    const f = fixture(); f.tx.auditLog.create.mockRejectedValue(Object.assign(new Error('synthetic FK failure'), { code: 'P2003' }));
    expect(await advanceStage({ prisma: f.prisma, orderId: 'order', stageKey: 'manufacturing', operator: 'leader' })).toMatchObject({ ok: false, error: { code: 'STAGE_UPDATE_FAILED' } });
    expect(f.tx.productionStage.update).not.toHaveBeenCalled(); // SQL rollback proven only by the real PG probe.
  });
});
