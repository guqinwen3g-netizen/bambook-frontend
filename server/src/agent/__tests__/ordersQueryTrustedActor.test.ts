/** Actual registered tool -> native current account/grants/L2/query callbacks.
 * Storage delegates alone are substituted; not PG, remote or complete Agent/UAT. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../toolRuntime';
import type { ToolExecutionContext } from '../toolDispatchRegistry';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';

const userId = 'ordinary-order-query-user';
const serverContext = (extra: any = {}): ToolExecutionContext => ({ actor: {
  userId, roles: ['owner'], departmentIds: [], permissionScopes: ['*'],
  permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: [], toolScopes: ['orders'], ...extra,
} });
function account(scopes = ['orders:read']) {
  return { id: userId, status: 'active', deletedAt: null,
    roles: [{ roleId: 'role-sales', role: { permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
}
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value == null) return row[key] == null;
    if (typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('has' in value) return (row[key] ?? []).includes(value.has);
      if ('contains' in value) return String(row[key] ?? '').includes(value.contains);
      return row[key] != null && matches(row[key], value);
    }
    return row[key] === value;
  });
}
function fixture() {
  let current: any = account();
  let overrides: any[] = [], memberships: any[] = [], shares: any[] = [];
  let afterPage: (() => void) | undefined;
  const relations = [{ id: 'own-customer', ownerId: userId, salesRepIds: [], deletedAt: null },
    { id: 'other-customer', ownerId: 'someone-else', salesRepIds: [], deletedAt: null },
    { id: 'shared-customer', ownerId: 'someone-else', salesRepIds: [], deletedAt: null }];
  const rows = relations.map(customer => ({ id: `order-${customer.id}`, poNumber: `PO-${customer.id}`,
    customerRelationId: customer.id, ownerId: 'someone-else', deletedAt: null, lines: [],
    customer: customer.id, quantity: 1, status: 'Pending' }));
  const prisma: any = {
    userAccount: { findFirst: vi.fn(async () => current) },
    userPermissionOverrides: { findMany: vi.fn(async ({ where }: any) => overrides.filter(row => matches(row, where))) },
    teamMember: { findMany: vi.fn(async ({ where }: any) => memberships.filter(row => matches(row, where))) },
    teamDataGrant: { findMany: vi.fn(async ({ where }: any) => shares.filter(row => matches(row, where))) },
    relation: { findMany: vi.fn(async ({ where }: any) => relations.filter(row => matches(row, where))) },
    order: {
      findMany: vi.fn(async ({ where, skip = 0, take, select }: any) => {
        const found = rows.filter(row => matches(row, where)).slice(skip, take == null ? undefined : skip + take);
        if (!select?.id && afterPage) { const hook = afterPage; afterPage = undefined; hook(); }
        return select?.id ? found.map(row => ({ id: row.id })) : found;
      }),
      count: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where)).length),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    },
    approvalRequest: { create: vi.fn() }, auditLog: { create: vi.fn() },
  };
  return { prisma, current: (value: any) => { current = value; },
    overrides: (value: any[]) => { overrides = value; }, afterPage: (hook: () => void) => { afterPage = hook; },
    share: () => {
      memberships = [{ userId, leftAt: null, teamId: 'query-team' }];
      shares = [{ teamId: 'query-team', entityType: 'relation', entityId: 'shared-customer', revokedAt: null, team: { deletedAt: null } }];
    }, revokeShare: () => { shares = []; },
  };
}
beforeEach(() => { vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', ''); __clearTeamShareCacheForTests(); });
afterEach(() => vi.unstubAllEnvs());
async function query(f: ReturnType<typeof fixture>, input: any = {}, context: ToolExecutionContext | undefined = serverContext()) {
  return executeTool(f.prisma, { toolId: 'orders.query', input }, context) as Promise<any>;
}
function noWrites(f: ReturnType<typeof fixture>) {
  expect(f.prisma.order.create).not.toHaveBeenCalled(); expect(f.prisma.order.update).not.toHaveBeenCalled();
  expect(f.prisma.order.delete).not.toHaveBeenCalled(); expect(f.prisma.approvalRequest.create).not.toHaveBeenCalled();
  expect(f.prisma.auditLog.create).not.toHaveBeenCalled();
}

describe('orders.query actual trusted actor propagation', () => {
  it('the same legitimate server context performs a current scoped read without approval', async () => {
    const f = fixture();
    const result = await query(f, { actor: { userId: 'someone-else', roles: ['owner'] }, ownerId: 'someone-else', limit: 1 });
    expect(result).toMatchObject({ ok: true, total: 1, count: 1, items: [{ id: 'order-own-customer' }] });
    expect(f.prisma.userAccount.findFirst.mock.calls.every(([args]: any) => args.where.id === userId)).toBe(true);
    expect(f.prisma.userAccount.findFirst).toHaveBeenCalledTimes(3);
    noWrites(f);
  });
  it('missing server context cannot be supplied by forged body actor, userId or permission claims', async () => {
    const f = fixture();
    await expect(executeTool(f.prisma, { toolId: 'orders.query', input: {
      actor: serverContext().actor, actorId: userId, userId, permissions: ['*'], permissionCeiling: ['*'],
    } })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.prisma.userAccount.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it('an audit actorId without the trusted principal cannot authorize a read', async () => {
    const f = fixture();
    await expect(query(f, {}, { actorId: userId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.prisma.userAccount.findFirst).not.toHaveBeenCalled(); noWrites(f);
  });
  it.each([{ ceiling: [] }, { ceiling: ['products:read'] }])('the actual signed ceiling $ceiling cannot borrow current grants or a forged body ceiling', async ({ ceiling }) => {
    const f = fixture();
    await expect(query(f, { actor: serverContext({ permissionCeiling: ['*'] }).actor }, serverContext({ permissionCeiling: ceiling })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.prisma.userAccount.findFirst).toHaveBeenCalled();
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it('current role permission withdrawal refuses the original still-signed context', async () => {
    const f = fixture(), context = serverContext({ permissionScopes: ['orders:read'], permissionCeiling: ['orders:read'] });
    expect((await query(f, {}, context)).total).toBe(1);
    f.current(account([]));
    await expect(query(f, {}, context)).rejects.toMatchObject({ code: 'FORBIDDEN' }); noWrites(f);
  });
  it('a current personal grant is usable and its native inactive row cannot survive in the original context', async () => {
    const f = fixture(), context = serverContext({ permissionScopes: ['orders:read'], permissionCeiling: ['orders:read'] });
    f.current(account([]));
    const grant = { userId, scope: 'orders:read', isActive: true, deletedAt: null, expiresAt: null };
    f.overrides([grant]); expect((await query(f, {}, context)).total).toBe(1);
    f.overrides([{ ...grant, isActive: false }]);
    await expect(query(f, {}, context)).rejects.toMatchObject({ code: 'FORBIDDEN' }); noWrites(f);
  });
  it('the current disabled account cannot borrow a valid old context', async () => {
    const f = fixture(); f.current({ ...account(), status: 'disabled' });
    await expect(query(f)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it('permission withdrawn after the actual page read rejects the whole response', async () => {
    const f = fixture(); f.afterPage(() => f.current(account([])));
    await expect(query(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.prisma.order.findMany).toHaveBeenCalledTimes(1); noWrites(f);
  });
  it('actual shared customer L2 is usable and late sharing withdrawal cannot return a stale page', async () => {
    const f = fixture(); f.share();
    expect((await query(f)).total).toBe(2);
    f.afterPage(() => f.revokeShare());
    await expect(query(f)).rejects.toMatchObject({ code: 'FORBIDDEN' }); noWrites(f);
  });
  it('current authorization storage failure is unavailable rather than an empty successful read', async () => {
    const f = fixture(); f.prisma.userPermissionOverrides.findMany.mockRejectedValue(new Error('private authorization storage fault'));
    await expect(query(f)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
    expect(f.prisma.order.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it('count uses the same current principal and complete native L2 predicate', async () => {
    const f = fixture();
    expect(await query(f, { aggregate: 'count' })).toMatchObject({ ok: true, aggregate: 'count', count: 1 });
    expect(f.prisma.order.findMany).not.toHaveBeenCalled();
    expect(f.prisma.userAccount.findFirst).toHaveBeenCalledTimes(3); noWrites(f);
  });
});
