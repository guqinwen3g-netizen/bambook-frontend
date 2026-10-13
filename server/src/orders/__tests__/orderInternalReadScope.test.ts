import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
const state = vi.hoisted(() => ({ resolver: { rule: { kind: 'team' }, allowedUserIds: ['lead', 'fabric-sales'], allowedDepartmentIds: [] } as any }));
vi.mock('../../auth/permissionService', () => ({ createPermissionService: () => ({ getDataScopeResolver: async () => state.resolver }) }));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ resolveVisibleRelationIds: async () => ['shared-customer'] }) }));
import { buildOrderListScopeWhere } from '../orderService';
const actor = { userId: 'lead', roles: ['sales_manager'], permissions: ['orders:read'], departmentIds: [] } as TokenPayload;

describe('internal fabric orders use actual business team scope without inventing a customer', () => {
  it('lets the actual group leader read member-owned internal supply while legacy customerless rows stay self only', async () => {
    state.resolver = { rule: { kind: 'team' }, allowedUserIds: ['lead', 'fabric-sales'], allowedDepartmentIds: [] };
    expect(await buildOrderListScopeWhere({} as any, actor, { fresh: true })).toEqual({ OR: [
      { customerRelationId: { in: ['shared-customer'] } },
      { AND: [{ customerRelationId: null }, { ownerId: 'lead' }] },
      { AND: [{ customerRelationId: null }, { orderPurpose: 'internal_fabric_supply' }, { OR: [{ ownerId: { in: ['lead', 'fabric-sales'] } }] }] },
    ] });
  });
  it('a colleague outside the resolved group is never included merely because it can approve orders', async () => {
    state.resolver = { rule: { kind: 'team' }, allowedUserIds: ['lead'], allowedDepartmentIds: [] };
    const where = await buildOrderListScopeWhere({} as any, actor);
    expect(JSON.stringify(where)).not.toContain('fabric-sales');
    expect((where.OR as any[])[2]).toEqual({ AND: [{ customerRelationId: null }, { orderPurpose: 'internal_fabric_supply' }, { ownerId: 'lead' }] });
  });
  it('an unresolved department whitelist is denied rather than expanded to all internal orders', async () => {
    state.resolver = { rule: { kind: 'department' }, allowedUserIds: [], allowedDepartmentIds: [] };
    expect(((await buildOrderListScopeWhere({} as any, actor)).OR as any[])[2]).toEqual({ AND: [
      { customerRelationId: null }, { orderPurpose: 'internal_fabric_supply' }, { ownerId: '__NOBODY__' },
    ] });
  });
});
