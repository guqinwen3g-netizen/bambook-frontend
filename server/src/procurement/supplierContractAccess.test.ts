import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../auth/service';
import { authorizeSupplierSources } from './supplierContractAccess';

const state = vi.hoisted(() => ({ permissions: ['procurement:write'], roles: ['sales'], active: true, visible: true, member: true, pending: false,
  mainFingerprint: 'a'.repeat(64), onLock: undefined as (() => void) | undefined }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: state.active ? 'active' : 'disabled', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx, user) => ({ userId: user.id, permissions: [...state.permissions], roles: [...state.roles], departmentIds: [], authorizationLoaded: true })) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({ ownerId: 'business' })) }));
const actor = (permissionCeiling?: string[]): TokenPayload => ({ userId: 'business', roles: ['sales'], permissions: ['*'], departmentIds: [], ...(permissionCeiling ? { permissionCeiling } : {}) });
function db() {
  const order = { id: 'order-1', status: 'Confirmed', businessLine: 'fabric', deletedAt: null, orderPurpose: 'external', quantity: '100', unit: 'M' };
  return { $queryRaw: vi.fn(async () => { state.onLock?.(); return [{ id: 'locked' }]; }),
    order: { findFirst: vi.fn(async () => state.visible ? order : null) },
    orderLine: { findMany: vi.fn(async () => [{ id: 'line-1', orderId: order.id, quantity: '100', unit: 'M', unitPrice: '10' }]) },
    approvalRequest: { findFirst: vi.fn(async (args) => args.where.status === 'pending' ? state.pending ? { id: 'main-pending' } : null : { id: 'main-approved', payload: { contentFingerprint: state.mainFingerprint } }) },
    teamMember: { findMany: vi.fn(async () => state.member ? [{ team: { status: 'active', deletedAt: null, department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['fabric_business'] } } } }] : []) },
  };
}
beforeEach(() => { state.permissions = ['procurement:write']; state.roles = ['sales']; state.active = true; state.visible = true; state.member = true;
  state.pending = false; state.mainFingerprint = 'a'.repeat(64); state.onLock = undefined; });
describe('supplier contract fresh exact source authority', () => {
  it('lets the actual fabric business member operate an exact visible approved line without an admin role', async () => {
    const result = await authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write', lock: true, formal: true });
    expect(result.sources[0]).toMatchObject({ orderId: 'order-1', orderLineId: 'line-1', businessLine: 'fabric', mainApprovalId: 'main-approved' });
  });
  it('requires the actual grant and the original credential ceiling together', async () => {
    await expect(authorizeSupplierSources(db(), actor(['procurement:read']), ['line-1'], { mode: 'write', lock: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    state.permissions = [];
    await expect(authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each(['scope', 'account', 'source', 'membership'] as const)('rechecks %s after the actual source lock', async change => {
    state.onLock = () => { if (change === 'scope') state.permissions = []; else if (change === 'account') state.active = false;
      else if (change === 'source') state.visible = false; else state.member = false; };
    await expect(authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write', lock: true })).rejects.toMatchObject({
      code: change === 'account' ? 'ACCOUNT_DISABLED' : change === 'source' ? 'NOT_FOUND' : 'FORBIDDEN',
    });
  });
  it('does not let an administrator role replace actual business membership', async () => {
    state.roles = ['admin']; state.permissions = ['*']; state.member = false;
    await expect(authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('freezes pending main approval and rejects unknown formal approval evidence', async () => {
    state.pending = true;
    await expect(authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write', formal: true })).rejects.toMatchObject({ code: 'SOURCE_APPROVAL_PENDING' });
    state.pending = false; state.mainFingerprint = 'legacy-unverifiable';
    await expect(authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write', formal: true })).rejects.toMatchObject({ code: 'SOURCE_NOT_APPROVED' });
    const history = await authorizeSupplierSources(db(), actor(), ['line-1'], { mode: 'write', businessGates: false });
    expect(history.sources[0].mainApprovalFingerprint).toBe('legacy-unverifiable');
  });
});
