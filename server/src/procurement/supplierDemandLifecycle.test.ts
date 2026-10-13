import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
const auth = vi.hoisted(() => ({ permissions: ['procurement:read', 'procurement:write'], roles: ['sales'], active: true, visible: true }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: auth.active ? 'active' : 'disabled', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx, user) => ({ userId: user.id, roles: auth.roles, permissions: auth.permissions, departmentIds: [], authorizationLoaded: true })) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => auth.visible ? { ownerId: 'business' } : { id: 'not-visible' }) }));
import { supplierContractMemoryFixture } from './supplierContractMemoryFixture';
import { createProcurementDemandService } from './procurementDemandService';
const actor = (ceiling?: string[]): TokenPayload => ({ userId: 'business', roles: ['sales'], permissions: ['*'], departmentIds: [], ...(ceiling ? { permissionCeiling: ceiling } : {}) });
function fixture() {
  const f = supplierContractMemoryFixture(); f.put('procurementDemand', { id: 'D1', kind: 'Material', sourceKey: 'manual-old', orderId: 'order-1', orderLineId: 'line-1', bomId: null, bomLineId: null, bomVersion: null,
    description: 'Actual raw material', unit: 'M', status: 'NeedsConfirmation', requiredQuantity: null, assigneeId: null, revision: 1, createdAt: 1n, updatedAt: 1n });
  return { ...f, service: createProcurementDemandService(f.db as unknown as PrismaClient) };
}
beforeEach(() => { auth.permissions = ['procurement:read', 'procurement:write']; auth.roles = ['sales']; auth.active = true; auth.visible = true; });
describe('fresh procurement demand planning', () => {
  it('actual business scope claims and explicitly confirms its accurate requirement, with no old PO write', async () => {
    const f = fixture(); await f.service.claim('D1', 1, 'business', null, actor());
    const result = await f.service.confirm('D1', { revision: 2, orderLineId: 'line-1', requiredQuantity: '157.5' }, 'business', null, actor());
    expect(result.demand).toMatchObject({ assigneeId: 'business', orderLineId: 'line-1', requiredQuantity: '157.5', status: 'Ready', revision: 3 }); expect(f.all('purchaseOrder')).toEqual([]);
  });
  it('requires the route trusted identity and retains its credential ceiling', async () => {
    const f = fixture(); await expect(f.service.claim('D1', 1, 'business', null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.service.claim('D1', 1, 'business', null, actor(['procurement:read']))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.service.claim('D1', 1, 'other', null, actor())).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.all('procurementDemand')[0].assigneeId).toBeNull();
  });
  it.each(['permission', 'account', 'L2', 'membership'] as const)('rechecks %s after the actual source and demand locks', async change => {
    const f = fixture(); f.db.onLock = () => { if (change === 'permission') auth.permissions = []; else if (change === 'account') auth.active = false;
      else if (change === 'L2') auth.visible = false; else f.tables.get('teamMember')!.clear(); };
    await expect(f.service.claim('D1', 1, 'business', null, actor())).rejects.toMatchObject({ code: change === 'account' ? 'ACCOUNT_DISABLED' : change === 'L2' ? 'NOT_FOUND' : 'FORBIDDEN' });
    expect(f.all('procurementDemand')[0].assigneeId).toBeNull(); expect(f.all('auditLog')).toEqual([]);
  });
  it('pending main approval freezes planning while an admin role supplies no missing business membership', async () => {
    const f = fixture(); f.put('approvalRequest', { id: 'main-pending', actionType: 'order:main_approval', targetType: 'Order', targetId: 'order-1', status: 'pending' });
    await expect(f.service.claim('D1', 1, 'business', null, actor())).rejects.toMatchObject({ code: 'SOURCE_APPROVAL_PENDING' });
    f.tables.get('approvalRequest')!.delete('main-pending'); auth.roles = ['admin']; auth.permissions = ['*']; f.tables.get('teamMember')!.clear();
    await expect(f.service.claim('D1', 1, 'business', null, actor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('fresh read L2 restricts the query even when the old caller visible array says all', async () => {
    const f = fixture(); auth.visible = false; expect(await f.service.list(null, 'business', {}, actor())).toMatchObject({ items: [], total: 0 });
    auth.visible = true; auth.permissions = []; await expect(f.service.list(null, 'business', {}, actor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('serializes purchase and processing allocation identities without querying nullable purchase IDs', async () => {
    const f = fixture(); f.put('purchaseOrder', { id: 'P1', poNumber: 'PO-1', supplierName: 'Raw supplier', businessOwnerId: 'business' });
    f.put('outsourcingOrder', { id: 'S1', orderNumber: 'OS-1', supplierId: 'processor-1', businessOwnerId: 'business' });
    f.put('purchaseDemandAllocation', { id: 'A1', demandId: 'D1', purchaseOrderId: 'P1', purchaseLineId: 'PL1', outsourcingOrderId: null, outsourcingLineId: null, quantity: new Prisma.Decimal('20.125'), status: 'Active', createdAt: 1n });
    f.put('purchaseDemandAllocation', { id: 'A2', demandId: 'D1', purchaseOrderId: null, purchaseLineId: null, outsourcingOrderId: 'S1', outsourcingLineId: 'OL1', quantity: new Prisma.Decimal('30'), status: 'Active', createdAt: 2n });
    const purchases = vi.spyOn(f.db.purchaseOrder, 'findMany'); const result = await f.service.list(null, 'business', {}, actor());
    expect(purchases).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['P1'] } } }));
    expect(result.items[0].allocations).toEqual([expect.objectContaining({ purchaseOrderId: 'P1', purchaseLineId: 'PL1', outsourcingOrderId: null, contractKind: 'purchase', contractNumber: 'PO-1', nativeContract: true }),
      expect.objectContaining({ purchaseOrderId: null, outsourcingOrderId: 'S1', outsourcingLineId: 'OL1', contractKind: 'processing', contractNumber: 'OS-1', nativeContract: true })]);
    expect(result.items[0].allocatedQuantity).toBe('50.125');
  });
  it('old allocation always returns a clear 409 before any legacy PO or mixed ProcessingService write', async () => {
    const f = fixture(); await expect(f.service.allocate('D1', { revision: 1, supplierRelationId: 'supplier-1', quantity: '1', unitPrice: '2', currency: 'CNY', requestKey: 'OLD' }, 'business', null, actor())).rejects.toMatchObject({ status: 409, code: 'NATIVE_SUPPLIER_CONTRACT_REQUIRED' });
    expect(f.all('purchaseOrder')).toEqual([]); expect(f.all('purchaseDemandAllocation')).toEqual([]);
  });
  it('manual creation keeps one original successful ID when main approval later freezes new planning', async () => {
    const f = fixture(), input = { requestKey: 'ORIGINAL', orderId: 'order-1', orderLineId: 'line-1', description: 'Actual demand', unit: 'M' };
    const first = await f.service.create(input, 'business', null, actor()); f.put('approvalRequest', { id: 'PENDING', actionType: 'order:main_approval', targetType: 'Order', targetId: 'order-1', status: 'pending' });
    const replay = await f.service.create(input, 'business', null, actor()); expect(replay.demand.id).toBe(first.demand.id); expect(f.all('procurementDemand')).toHaveLength(2);
    await expect(f.service.create({ ...input, requestKey: 'NEW' }, 'business', null, actor())).rejects.toMatchObject({ code: 'SOURCE_APPROVAL_PENDING' });
  });
});
