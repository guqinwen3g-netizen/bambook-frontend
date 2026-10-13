import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import { currentOrderLineWriteActor } from '../orderLineWriteAccess';

// Real current-account, personal-grant and ceiling resolution. Storage only is
// substituted; this suite never creates a PrismaClient or HTTP listener.
const prior: TokenPayload = { userId: 'sales-current', roles: ['owner'], permissions: ['*'], departmentIds: [] };
function storage(scopes = ['orders:write'], roleId = 'role-sales') {
  const user = { id: prior.userId, status: 'active', deletedAt: null as Date | null, primaryDeptId: 'sales-dept',
    roles: [{ roleId, role: { id: roleId, permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const tx = { userAccount: { findFirst: vi.fn(async (): Promise<typeof user | null> => user) }, userPermissionOverrides: { findMany: vi.fn(async () => []) } };
  return { tx, user };
}

describe('current Orders action scopes authorize order-line business work', () => {
  it('allows a current sales account with orders:write to maintain its draft', async () => {
    const f = storage();
    await expect(currentOrderLineWriteActor(f.tx, prior, 'create')).resolves.toMatchObject({
      userId: prior.userId, roles: ['sales'], permissions: ['orders:write'], authorizationLoaded: true,
    });
    expect(f.tx.userAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(f.tx.userPermissionOverrides.findMany).toHaveBeenCalledTimes(1);
  });
  it.each(['update', 'version'] as const)('allows a sales writer to perform %s, including shared fulfillment callers', async action => {
    const f = storage();
    await expect(currentOrderLineWriteActor(f.tx, prior, action)).resolves.toMatchObject({ roles: ['sales'] });
  });
  it('uses an explicit custom-role grant rather than the display role as authority', async () => {
    const f = storage(['orders:write'], 'role-order-operator');
    await expect(currentOrderLineWriteActor(f.tx, prior, 'update')).resolves.toMatchObject({ roles: [], permissions: ['orders:write'] });
  });
  it('orders:write never grants delete', async () => {
    await expect(currentOrderLineWriteActor(storage().tx, prior, 'delete')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('a sales account with an explicit orders:delete grant can delete within the draft boundary', async () => {
    await expect(currentOrderLineWriteActor(storage(['orders:delete']).tx, prior, 'delete')).resolves.toMatchObject({ roles: ['sales'] });
  });
  it.each([{ permissionCeiling: [] }, { permissionCeiling: ['orders:read'] }])('a current grant cannot widen signed credential ceiling $permissionCeiling', async ({ permissionCeiling }) => {
    await expect(currentOrderLineWriteActor(storage().tx, { ...prior, permissionCeiling }, 'update')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('reloads a revoked grant instead of trusting the signed owner role', async () => {
    await expect(currentOrderLineWriteActor(storage(['orders:read']).tx, prior, 'update')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each(['inactive', 'deleted', 'absent'])('rejects a current %s account', async state => {
    const f = storage();
    if (state === 'absent') f.tx.userAccount.findFirst.mockResolvedValue(null);
    else if (state === 'inactive') f.user.status = 'inactive';
    else f.user.deletedAt = new Date();
    await expect(currentOrderLineWriteActor(f.tx, prior, 'update')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
  it('fails closed when current personal grants cannot be loaded', async () => {
    const f = storage(); f.tx.userPermissionOverrides.findMany.mockRejectedValue(Error('grant read failed'));
    await expect(currentOrderLineWriteActor(f.tx, prior, 'update')).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
  });
});
