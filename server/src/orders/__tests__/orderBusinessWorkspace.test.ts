import { describe, expect, it, vi } from 'vitest';
import { createOrderBusinessWorkspaceService } from '../orderBusinessWorkspaceService';
const mocked = vi.hoisted(() => ({ user: { id: 'sales', status: 'active', deletedAt: null }, actor: { userId: 'sales', roles: [], permissions: ['orders:read', 'orders:write', 'shipments:write'] } }));
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async () => mocked.user), buildLoadedAuthTokenPayload: vi.fn(async () => ({ ...mocked.actor })) }));
vi.mock('../orderLineWriteAccess', () => ({ currentOrderLineWriteActor: vi.fn(async () => ({ ...mocked.actor })), freshOrderLineScope: vi.fn(async () => ({ ownerId: 'sales' })) }));
vi.mock('../../production/releaseService', () => ({ evaluateProductionRelease: vi.fn(async () => ({ ok: true, data: { eligible: true } })) }));
vi.mock('../../development/fabricAssetEligibility', () => ({ assertConfirmedFabricSourceEligible: vi.fn(async () => ({})) }));
vi.mock('../internalFabricGate', () => ({ resolveGarmentMaterialProof: vi.fn(async () => null) }));
function fixture() {
  const order = { id: 'O', type: 'fabric', status: 'Confirmed', ownerId: 'sales' };
  const line = { id: 'L', orderId: 'O', lineNumber: 1, quantity: '1000', unit: 'm', confirmedSourceType: 'Asset', confirmedSourceId: 'A', specSnapshot: { mainCategory: 'fabric' } };
  const batch = { id: 'B', orderId: 'O', orderLineId: 'L', revision: 2, quantity: '1000', unit: 'm', factoryRelationId: 'F' };
  const db = { order: { findFirst: vi.fn(async () => order) }, orderLine: { findMany: vi.fn(async () => [line]), findUnique: vi.fn(async () => line) },
    productionBatch: { findMany: vi.fn(async () => [batch]), findUnique: vi.fn(async () => batch) }, approvalRequest: { findMany: vi.fn(async () => []) },
    releaseScope: { findMany: vi.fn(async () => [{ id: 'RS', scopeRevision: 1 }]) }, shipmentHandoffLine: { findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn() } };
  return { db, order, line, batch, service: createOrderBusinessWorkspaceService({ prisma: db }) };
}
describe('order workspace exact scope and read-only factual projection', () => {
  it('does not choose the first line or treat Confirmed status and a neutral branch as approval', async () => {
    const f = fixture(), result = await f.service.read('O', mocked.actor);
    expect(result.scope).toEqual({ kind: 'order_main', orderId: 'O' });
    expect(result.overview.formalApprovalVerified).toBe(false);
    expect(result.nodes.find(row => row.id === 'fulfillment')).toMatchObject({ canOpen: false, canContinue: false });
    expect(f.db.orderLine.findUnique).not.toHaveBeenCalled(); expect(f.db.releaseScope.findMany).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it('rejects missing line, orphan revision, blank explicit IDs and stale branch revision instead of falling back', async () => {
    const f = fixture();
    for (const input of [{ orderLineId: '' }, { productionBatchRevision: 2 }, { productionBatchId: 'B', productionBatchRevision: 2 }, { orderLineId: 'L', productionBatchId: 'B' }])
      await expect(f.service.read('O', mocked.actor, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.service.read('O', mocked.actor, { orderLineId: 'L', productionBatchId: 'B', productionBatchRevision: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('does not use a read-only credential ceiling to authorize even the current order summary', async () => {
    const f = fixture(); await expect(f.service.read('O', { ...mocked.actor, permissionCeiling: ['products:read'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.order.findFirst).not.toHaveBeenCalled();
  });
});
