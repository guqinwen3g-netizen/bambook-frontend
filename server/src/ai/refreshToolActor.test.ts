import { describe, expect, it, vi } from 'vitest';
import { refreshToolActor } from './refreshToolActor';
import { createIdentityService } from '../agent/identity';
import { createPolicyService } from '../agent/policy';
import { hasScope } from '../auth/permissionService';
import { toolActorToken } from '../agent/toolActorContext';
const prior = () => createIdentityService().resolveActorContext({ userId: 'operator', roles: ['sales'], permissions: ['products:write', 'orders:read'], authorizationLoaded: true });
function storage(scopes: string[], options: { status?: string; roleId?: string; personal?: string[] } = {}) {
  return {
    userAccount: { findFirst: vi.fn(async () => ({ id: 'operator', status: options.status ?? 'active', deletedAt: null,
      roles: [{ roleId: options.roleId ?? 'role-sales', role: { permissions: scopes.map(scope => ({ permission: { scope } })) } }], primaryDeptId: 'department-b' })) },
    userPermissionOverrides: { findMany: vi.fn(async () => (options.personal ?? []).map(scope => ({ scope }))) },
  } as any;
}
describe('current identity before each Agent tool and approval resume', () => {
  it('uses an authoritative empty snapshot after grants are withdrawn', async () => {
    const actor = await refreshToolActor(storage([]), await prior(), { userId: 'operator', requestSource: 'user-session' });
    expect(actor.permissionScopes).toEqual([]); expect(actor.permissionsAuthoritative).toBe(true);
    expect(actor.toolScopes).not.toContain('products'); expect(actor.departmentIds).toEqual(['department-b']);
  });
  it('uses actual custom-role and personal grants without old sales defaults', async () => {
    const actor = await refreshToolActor(storage(['products:read'], { roleId: 'custom', personal: ['orders:read'] }), await prior(), { userId: 'operator' });
    expect(actor.permissionScopes.sort()).toEqual(['orders:read', 'products:read']);
    expect(actor.roles).toEqual([]);
  });
  it('never expands an API key session beyond its trusted initial ceiling', async () => {
    const actor = await refreshToolActor(storage(['products:write', 'orders:write']), await prior(), { userId: 'operator', requestSource: 'api-key', permissionCeiling: ['products:read'] });
    expect(actor.permissionScopes).toEqual([]); expect(actor.permissionsAuthoritative).toBe(true);
  });
  it('a current technical owner cannot escape a restricted key ceiling', async () => {
    const actor = await refreshToolActor(storage(['products:read', 'products:write'], { roleId: 'role-super-admin' }), await prior(), { userId: 'operator', requestSource: 'api-key', permissionCeiling: ['products:read', 'tools:execute'] });
    expect(actor.roles).toContain('owner');
    expect(createPolicyService().canUseTool(actor, { toolId: 'products.query', scope: 'products', risk: 'low' }).allowed).toBe(true);
    expect(createPolicyService().canUseTool(actor, { toolId: 'product_asset.create', scope: 'products', risk: 'high' }).allowed).toBe(false);
    expect(hasScope(toolActorToken(actor), 'sensitive:cost')).toBe(false);
  });
  it('rejects inactive accounts, mismatched checkpoint subjects and failed grant loading', async () => {
    await expect(refreshToolActor(storage([], { status: 'inactive' }), await prior(), { userId: 'operator' })).rejects.toThrow('ACCOUNT_INACTIVE');
    const db = storage([]);
    await expect(refreshToolActor(db, await prior(), { userId: 'someone-else' })).rejects.toThrow('SUBJECT_MISMATCH');
    expect(db.userAccount.findFirst).not.toHaveBeenCalled();
    db.userPermissionOverrides.findMany.mockRejectedValue(Error('unavailable'));
    await expect(refreshToolActor(db, await prior(), { userId: 'operator' })).rejects.toThrow('unavailable');
  });
});
