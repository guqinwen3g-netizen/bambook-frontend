import { describe, expect, it } from 'vitest';
import { createIdentityService } from '../identity';
import { createPolicyService } from '../policy';

describe('trusted Agent authorization snapshots', () => {
  it('uses explicit scopes rather than role defaults and preserves their order', async () => {
    const actor = await createIdentityService().resolveActorContext({
      userId: 'sales-withdrawn', roles: ['sales'], roleIds: ['role-sales'],
      permissions: ['orders:read', 'qc:read'], authorizationLoaded: true,
    });
    expect(actor.permissionScopes).toEqual(['orders:read', 'qc:read']);
    expect(actor.toolScopes).toEqual(['orders', 'qc']);
    expect(actor.toolScopes).not.toContain('relations');
    expect(createPolicyService().canUseTool(actor, {
      toolId: 'finance.list_invoices', scope: 'finance', risk: 'low',
    })).toMatchObject({ allowed: false });
  });
  it('does not restore legacy tools for an intentionally empty loaded snapshot', async () => {
    const actor = await createIdentityService().resolveActorContext({
      userId: 'empty-grant', roles: ['sales'], roleIds: ['role-sales'],
      permissions: [], authorizationLoaded: true,
    });
    expect(actor.permissionScopes).toEqual([]);
    expect(actor.toolScopes).toEqual([]);
    expect(createPolicyService().canUseTool(actor, {
      toolId: 'orders.query', scope: 'orders', risk: 'low',
    })).toMatchObject({ allowed: false });
  });
  it('retains the legacy unmarked empty-snapshot compatibility boundary', async () => {
    const identity = createIdentityService();
    const legacy = await identity.resolveActorContext({ userId: 'old-sales', roles: ['sales'] });
    const empty = await identity.resolveActorContext({ userId: 'old-sales', roles: ['sales'], permissions: [] });
    expect(empty.permissionScopes).toEqual(legacy.permissionScopes);
    expect(empty.toolScopes).toEqual(legacy.toolScopes);
    expect(empty.permissionsAuthoritative).toBe(false);
  });
  it('supports configured custom roles with effective grants without inventing a legacy role', async () => {
    const actor = await createIdentityService().resolveActorContext({
      userId: 'custom-employee', roles: [], roleIds: ['custom-preauthorized-reader'],
      permissions: ['orders:read'], authorizationLoaded: true,
    });
    expect(actor.roles).toEqual([]);
    expect(actor.permissionScopes).toEqual(['orders:read']);
    expect(actor.toolScopes).toEqual(['orders']);
  });
  it('an absent trusted role still cannot become an owner implicitly', async () => {
    await expect(createIdentityService().resolveActorContext({
      userId: 'untrusted', permissions: ['orders:read'],
    })).rejects.toThrow('ACTOR_ROLES_REQUIRED');
  });
});
