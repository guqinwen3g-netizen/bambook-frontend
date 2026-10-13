import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { resolveGarmentMaterialProof } from '../internalFabricGate';

const order = { id: 'garment', type: 'Garment', businessLine: 'garment' };
const line = { id: 'garment-line', orderId: order.id, fulfillmentMode: 'full_package', cmtIncludedItems: ['sewing'] };
function database() {
  const allocation = { id: 'allocation', fabricOrderId: 'fabric', fabricOrderLineId: 'fabric-line', garmentOrderId: order.id,
    garmentOrderLineId: line.id, status: 'active', revision: 1, metres: new Prisma.Decimal('0.5001'), auditId: 'audit' };
  const supply = { id: 'fabric', type: 'Fabric', businessLine: 'fabric', status: 'Confirmed', orderPurpose: 'internal_fabric_supply',
    internalPurpose: 'PP 与正式成衣供料', internalDemandTeamId: 'actual-team', internalReceiverId: 'receiver' };
  const sourceLine = { id: 'fabric-line', orderId: 'fabric', quantity: new Prisma.Decimal('1.0001'), unit: 'm' };
  const db = {
    fabricLineAllocation: { findUnique: vi.fn(async () => allocation), findMany: vi.fn(async () => [allocation]) },
    order: { findFirst: vi.fn(async () => supply) }, orderLine: { findUnique: vi.fn(async () => sourceLine) },
    team: { findFirst: vi.fn(async () => ({ id: 'actual-team', name: '成衣组', status: 'active', metadata: { businessFamily: 'garment' } })) },
    teamMember: { findFirst: vi.fn(async () => ({ userId: 'receiver', leftAt: null })) },
    userAccount: { findFirst: vi.fn(async () => ({ id: 'receiver', status: 'active' })) },
    approvalRequest: { findFirst: vi.fn(async () => ({ id: 'actual-approval' })) },
    auditLog: { findUnique: vi.fn(async () => ({ id: 'audit', action: 'allocate_internal_fabric', targetType: 'FabricLineAllocation', targetId: allocation.id,
      detail: { after: { ...allocation, metres: allocation.metres.toString() } } })) },
  };
  return { db, allocation, supply, sourceLine };
}
describe('accurate garment material consumption', () => {
  it('retains an unknown historical mode as blocked, and CMT needs no internal fabric lookup', async () => {
    await expect(resolveGarmentMaterialProof({}, order, { id: line.id })).rejects.toThrow('请选择成衣');
    expect(await resolveGarmentMaterialProof({}, order, { ...line, fulfillmentMode: 'cmt', cmtIncludedItems: [] }))
      .toEqual({ schemaVersion: 1, fulfillmentMode: 'cmt', cmtIncludedItems: [], allocation: null });
  });
  it('allows an approved accurate plan before fabric production or physical intake', async () => {
    const { db } = database();
    const proof = await resolveGarmentMaterialProof(db, order, line);
    expect(proof?.allocation).toMatchObject({ id: 'allocation', revision: 1, metres: '0.5001', fabricLineQuantity: '1.0001', approvalId: 'actual-approval', internalDemandTeamId: 'actual-team' });
  });
  it('refuses cancelled, overallocated, unaudited and unapproved plans without changing history', async () => {
    const cancelled = database(); cancelled.allocation.status = 'cancelled';
    await expect(resolveGarmentMaterialProof(cancelled.db, order, line)).rejects.toThrow('有效内部面料');
    const exceeded = database(); exceeded.sourceLine.quantity = new Prisma.Decimal('0.5');
    await expect(resolveGarmentMaterialProof(exceeded.db, order, line)).rejects.toThrow('超过');
    const unapproved = database(); unapproved.db.approvalRequest.findFirst.mockResolvedValue(null as never);
    await expect(resolveGarmentMaterialProof(unapproved.db, order, line)).rejects.toThrow('审批');
    const unaudited = database(); unaudited.db.auditLog.findUnique.mockResolvedValue(null as never);
    await expect(resolveGarmentMaterialProof(unaudited.db, order, line)).rejects.toThrow('审计');
  });
  it('changes proof when exact planning revision or source quantity changes', async () => {
    const fixture = database(), before = await resolveGarmentMaterialProof(fixture.db, order, line);
    fixture.allocation.revision = 2; fixture.allocation.metres = new Prisma.Decimal('0.6');
    const after = await resolveGarmentMaterialProof(fixture.db, order, line);
    expect(after).not.toEqual(before);
    expect(before?.allocation?.metres).toBe('0.5001');
    fixture.sourceLine.quantity = new Prisma.Decimal('2');
    expect(await resolveGarmentMaterialProof(fixture.db, order, line)).not.toEqual(after);
  });
});
