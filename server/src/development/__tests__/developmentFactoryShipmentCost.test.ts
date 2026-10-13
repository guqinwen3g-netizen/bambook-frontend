import { describe, expect, it, vi } from 'vitest';
import { createDevelopmentFactoryShipmentCost, bindDevelopmentFactoryShipmentCost, verifyDevelopmentFactoryShipmentCost } from '../developmentFactoryShipmentCost';

// Keep the shared billing writer and its audit real; only the unrelated number allocator is isolated.
vi.mock('../../shared/businessNumberService', () => ({ nextBusinessNumber: vi.fn(async () => 'CR-20261001-0001') }));
function fixture() {
  const costs: any[] = [], audits: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ id: 'case' }]),
    developmentCase: { findFirst: vi.fn(async () => ({ id: 'case', stage: 'closed' })) },
    costRecord: {
      create: vi.fn(async ({ data }: any) => { const row = { ...data, deletedAt: null, bearerRelationId: null }; costs.push(row); return row; }),
      findFirst: vi.fn(async ({ where }: any) => costs.find(row => row.id === where.id) ?? null),
      findMany: vi.fn(async () => costs),
      update: vi.fn(async ({ where, data }: any) => Object.assign(costs.find(row => row.id === where.id), data)),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }),
      findMany: vi.fn(async ({ where }: any) => audits.filter(row => Object.entries(where).every(([key, value]) => row[key] === value))),
    },
  };
  const ctx = { actorId: 'sales', trustedActor: { userId: 'sales' } as any };
  const raw = { caseId: 'case', itemId: 'card', itemCode: 'SC-1', physical: { unit: 'M' }, task: { sampleVersionId: 'v1', factoryId: 'factory' },
    stock: { eventId: 'stock-event' }, shipping: { shippingFee: '99999999999999.9999', shippingCurrency: 'USD', sentDate: '2026-10-01', courier: 'DHL', trackingNumber: 'TRACK' } };
  return { tx, ctx, raw, costs, audits };
}

describe('factory cost uses the shared billing truth in the caller transaction', () => {
  it.each(['missing', 'id', 'creation pointer', 'amount', 'currency', 'sourceId', 'recordNo', 'source', 'actorId', 'targetId', 'duplicate'])('native success requires its separate canonical billing audit: %s', async field => {
    const f = fixture(), fingerprint = 'f'.repeat(64);
    const shippingCost = await createDevelopmentFactoryShipmentCost(f.tx, f.ctx, 'case', 'original', fingerprint, f.raw);
    const result = { ...f.raw, shippingCost, command: { kind: 'factory', actorId: 'sales', requestKey: 'original', fingerprint } };
    await bindDevelopmentFactoryShipmentCost(f.tx, f.ctx, 'case', { ...result, auditId: 'physical-original' });
    const audit=f.audits.find(row=>row.action==='create_cost_record');
    if(field==='missing')f.audits.splice(f.audits.indexOf(audit),1);
    else if(field==='duplicate')f.audits.push({...audit,id:'duplicate-billing'});
    else if(field==='creation pointer')f.costs[0].developmentShippingSource.creationAuditId='changed';
    else if(field==='id')audit.id='changed';
    else if(field==='source')audit.detail.source='other';
    else if(field==='actorId'||field==='targetId')audit[field]='other';
    else audit.detail.after[field]=field==='amount'?'1':'changed';
    await expect(verifyDevelopmentFactoryShipmentCost(f.tx,'case',result,'physical-original')).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  });
  it('preserves maximum Decimal precision and explicit payer/date/currency through billing audit and binding readback', async () => {
    const f = fixture(), fingerprint = 'f'.repeat(64);
    const shippingCost = await createDevelopmentFactoryShipmentCost(f.tx, f.ctx, 'case', 'original', fingerprint, f.raw);
    const result = { ...f.raw, shippingCost, command: { kind: 'factory', actorId: 'sales', requestKey: 'original', fingerprint } };
    await bindDevelopmentFactoryShipmentCost(f.tx, f.ctx, 'case', { ...result, auditId: 'physical-original' });
    expect(f.costs).toHaveLength(1);
    expect(f.costs[0].amount.toFixed(4)).toBe('99999999999999.9999');
    expect(f.costs[0]).toMatchObject({ sourceType: 'DevelopmentCase', sourceId: 'case', costType: 'shipping', currency: 'USD', incurredAt: '2026-10-01', bearerType: 'internal', bearerRelationId: null });
    expect(f.audits.map(row => row.action)).toEqual(['create_cost_record', 'development_factory_shipping_cost_bind']);
    expect(f.audits[0].detail.after.amount).toBe('99999999999999.9999');
    expect(await verifyDevelopmentFactoryShipmentCost(f.tx, 'case', result, 'physical-original')).toMatchObject({ kind: 'factory-physical-command', id: 'physical-original', nativeAuditId: 'physical-original', fingerprint: shippingCost.sourceFingerprint });
    expect(f.tx.$queryRaw).toHaveBeenCalled(); // The shared writer holds the case lock, including late expense cases.
  });
  it('an actual shared billing audit failure aborts the composition rather than returning a successful cost proof', async () => {
    const f = fixture();
    f.tx.auditLog.create.mockRejectedValueOnce(Error('billing audit unavailable'));
    await expect(createDevelopmentFactoryShipmentCost(f.tx, f.ctx, 'case', 'original', 'f'.repeat(64), f.raw)).rejects.toThrow('billing audit unavailable');
    expect(f.tx.costRecord.update).not.toHaveBeenCalled();expect(f.audits).toHaveLength(0);
  });
});
