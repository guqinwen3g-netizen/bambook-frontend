/** Real Express/JWT, employee-key binding, current permission loaders and
 * Orders L2 query builder. Only storage is substituted; these probes do not
 * prove real PG contents/isolation or company UAT. No auth guard is mocked. */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../service';
import { getDefaultAgentApiKeyActors, setDefaultAgentApiKeyActors } from '../agentPrincipal';
import { createOrderLinesRouter } from '../../orders/orderLinesRoute';
import { recordAuthorityFixtureProof } from './currentAuthorityFixtureProof';

const auth = createAuthService(), userId = 'u_order_line_read', apiKey = 'synthetic-bound-order-line-key';
let previousBindings: ReturnType<typeof getDefaultAgentApiKeyActors>;
beforeEach(() => { previousBindings = getDefaultAgentApiKeyActors(); setDefaultAgentApiKeyActors(new Map()); });
afterEach(() => { setDefaultAgentApiKeyActors(new Map(previousBindings)); });
function account(scopes: string[] = ['orders:read'], roleId = 'role-sales') {
  return { id: userId, status: 'active', deletedAt: null, roles: [{ roleId, role: { id: roleId, name: 'Not authority', permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
}
function token(extra: any = {}) { return auth.signToken({ userId, roles: ['owner'], permissions: ['orders:read'], authorizationLoaded: true, departmentIds: [], ...extra }); }
function bind(extra: any = {}) {
  // This is the existing module-level server binding seam. It is not an HTTP
  // body/principal input, and storage/current grants remain independently read.
  setDefaultAgentApiKeyActors(new Map([[apiKey, { userId, displayName: 'Synthetic bound employee', roles: ['sales'],
    permissions: ['orders:read'], authorizationLoaded: true, departmentIds: [], ...extra }]]));
}
function matches(row: any, where: any): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([key, condition]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every(value => matches(row, value));
    if (key === 'OR') return condition.some((value: any) => matches(row, value));
    if (condition === null) return row[key] == null;
    if (condition && typeof condition === 'object') {
      if ('in' in condition) return condition.in.includes(row[key]);
      if ('has' in condition) return (row[key] ?? []).includes(condition.has);
      if ('gt' in condition) return row[key] != null && row[key] > condition.gt;
      return matches(row[key], condition);
    }
    return row[key] === condition;
  });
}
/** Current storage select projection; no credential fields or role defaults. */
function projectCurrent(row: any, select?: any): any {
  if (row == null) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(select).filter(([, value]) => value).map(([key, value]: [string, any]) => [key,
    value === true ? row[key] ?? null
      : Array.isArray(row[key]) ? row[key].map((item: any) => projectCurrent(item, value.select))
      : projectCurrent(row[key], value.select)]));
}
let latestFixture: any;
function fixture(requireAuth = false) {
  let current: any = account(), overrides: any[] = [], memberships: any[] = [], shares: any[] = [];
  const relations = [
    { id: 'C_OWN', ownerId: userId, salesRepIds: [], deletedAt: null },
    { id: 'C_OTHER', ownerId: 'u_other', salesRepIds: [], deletedAt: null },
    { id: 'C_SHARED', ownerId: 'u_other', salesRepIds: [], deletedAt: null },
  ];
  const orders = [
    { id: 'O_OWN', customerRelationId: 'C_OWN', ownerId: 'u_creator', deletedAt: null, importedAt: 2, poNumber: 'PO_OWN', customer: 'Synthetic followed customer' },
    { id: 'O_OTHER', customerRelationId: 'C_OTHER', ownerId: userId, deletedAt: null, importedAt: 3, poNumber: 'PO_OTHER', customer: 'Unrelated actual customer' },
    { id: 'O_SHARED', customerRelationId: 'C_SHARED', ownerId: 'u_creator', deletedAt: null, importedAt: 4, poNumber: 'PO_SHARED', customer: 'Synthetic shared customer' },
    { id: 'O_LEGACY', customerRelationId: null, ownerId: userId, deletedAt: null, importedAt: 1, poNumber: 'PO_LEGACY', customer: 'Unlinked synthetic description' },
    { id: 'O_DELETED', customerRelationId: 'C_OWN', ownerId: userId, deletedAt: 1, importedAt: 5, poNumber: 'PO_DELETED', customer: 'Deleted parent' },
  ];
  const lines = orders.flatMap(order => [{ id: `${order.id}-L2`, orderId: order.id, lineNumber: 2, quantity: '2.75', order },
    { id: `${order.id}-L1`, orderId: order.id, lineNumber: 1, quantity: '1.25', order }]);
  const storage = (rows: () => any[]) => vi.fn(async ({ where }: any) => rows().filter(row => matches(row, where)));
  const prisma: any = {
    userAccount: { findFirst: vi.fn(async () => current),
      findUnique: vi.fn(async ({ where, select }: any) => matches(current, where) ? projectCurrent(current, select) : null) }, userPermissionOverrides: { findMany: storage(() => overrides) },
    teamMember: { findMany: storage(() => memberships) }, teamDataGrant: { findMany: storage(() => shares) }, relation: { findMany: storage(() => relations) },
    orderLine: { findMany: vi.fn(async ({ where }: any) => lines.filter(line => matches(line, where)).sort((a, b) => b.order.importedAt - a.order.importedAt || a.lineNumber - b.lineNumber)),
      create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    order: { create: vi.fn(), update: vi.fn() }, auditLog: { create: vi.fn() }, entityReference: { upsert: vi.fn() }, entityLink: { upsert: vi.fn() }, $transaction: vi.fn(),
  };
  const app = express(), onDataChange = vi.fn(); app.use(express.json());
  app.use('/order-lines', createOrderLinesRouter({ prisma, requireAuth, apiKeys: new Set([apiKey]), onDataChange }));
  const result = { app, prisma, onDataChange, current: (value: any) => { current = value; },
    override: (value: any[]) => { overrides = value; }, share: () => {
      memberships = [{ userId, teamId: 'TEAM', leftAt: null, team: { status: 'active', deletedAt: null } }];
      shares = [{ teamId: 'TEAM', entityType: 'relation', entityId: 'C_SHARED', revokedAt: null, team: { status: 'active', deletedAt: null } }];
    }, revokeShare: () => { shares = []; } };
  latestFixture = result;
  return result;
}
afterEach(async context=>recordAuthorityFixtureProof('currentOrderLineReadAccess.test.ts',context.task,latestFixture));
type Fixture = ReturnType<typeof fixture>;
const code = (response: any) => response.body.error?.code ?? response.body.error;
const read = (f: Fixture, query = '', signed = token()) => request(f.app).get(`/order-lines${query}`).set('Authorization', `Bearer ${signed}`);
function noWrite(f: Fixture) {
  for (const method of [f.prisma.orderLine.create, f.prisma.orderLine.update, f.prisma.orderLine.updateMany, f.prisma.orderLine.delete,
    f.prisma.order.create, f.prisma.order.update, f.prisma.auditLog.create, f.prisma.entityReference.upsert, f.prisma.entityLink.upsert, f.prisma.$transaction, f.onDataChange]) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe.each([false, true])('OrderLine current read contract requireAuth=%s', configured => {
  it('anonymous/forged body owner is refused before data query', async () => {
    const f = fixture(configured), response = await request(f.app).get('/order-lines').send({ actor: { userId, roles: ['owner'], permissions: ['orders:read'] } });
    expect(response.status).toBe(401); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('accepted but unbound legacy key is not anonymous all-data authority', async () => {
    const f = fixture(configured), response = await request(f.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(401); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('real employee binding uses current DB read grants and L2, without a leadership role', async () => {
    const f = fixture(configured); bind(); const response = await request(f.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.lines.map((line: any) => line.orderId)).toEqual(['O_OWN', 'O_OWN', 'O_LEGACY', 'O_LEGACY']);
    expect(f.prisma.userAccount.findFirst.mock.calls[0][0].where.id).toBe(userId); noWrite(f);
  });
  it('bound employee grant revocation cannot be restored from key-startup scopes', async () => {
    const f = fixture(configured); bind(); f.current(account([]));
    const response = await request(f.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('bound employee inactivity is refused despite a valid accepted key', async () => {
    const f = fixture(configured); bind(); f.current({ ...account(), status: 'inactive' });
    const response = await request(f.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(401); expect(code(response)).toBe('ACCOUNT_DISABLED'); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('bound owner read grants still cannot exceed the server credential cap', async () => {
    const f = fixture(configured); bind({ permissionCeiling: ['orders:write'] }); f.current(account(['orders:read'], 'role-super-admin'));
    const response = await request(f.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(403); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('legitimate current sales read works with a legacy empty signed role/scope snapshot', async () => {
    const f = fixture(configured), response = await read(f, '', token({ roles: [], permissions: [], authorizationLoaded: undefined }));
    expect(response.status).toBe(200); expect(response.body.lines.map((line: any) => line.id)).toEqual(['O_OWN-L1', 'O_OWN-L2', 'O_LEGACY-L1', 'O_LEGACY-L2']);
    expect(f.prisma.orderLine.findMany.mock.calls[0][0].orderBy).toEqual([{ order: { importedAt: 'desc' } }, { lineNumber: 'asc' }]);
    expect(response.body.lines[0]).toMatchObject({ poNumber: 'PO_OWN', customer: 'Synthetic followed customer', quantity: '1.25', order: { id: 'O_OWN' } }); noWrite(f);
  });
  it('current owner role cannot invent an absent explicit read permission', async () => {
    const f = fixture(configured); f.current(account([], 'role-super-admin')); const response = await read(f);
    expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('signed write-only cap cannot be widened by current owner read grants', async () => {
    const f = fixture(configured); f.current(account(['orders:read'], 'role-super-admin'));
    const response = await read(f, '', token({ permissionCeiling: ['orders:write'] }));
    expect(response.status).toBe(403); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
});

describe('OrderLine read filter, current grant and fresh L2', () => {
  it.each(['', '?orderId=O_OTHER'])('whole/specific query %s cannot return an unrelated real customer even for the order creator', async query => {
    const f = fixture(), response = await read(f, query); expect(response.status).toBe(200);
    expect(response.body.lines.some((line: any) => line.orderId === 'O_OTHER')).toBe(false);
    const where = f.prisma.orderLine.findMany.mock.calls[0][0].where; expect(where.order.AND[0].OR).toBeDefined();
    if (query) expect(where.orderId).toBe('O_OTHER'); noWrite(f);
  });
  it('explicit own order filter is ANDed before query and preserves line sorting', async () => {
    const f = fixture(), response = await read(f, '?orderId=%20O_OWN%20'); expect(response.status).toBe(200);
    expect(response.body.lines.map((line: any) => line.id)).toEqual(['O_OWN-L1', 'O_OWN-L2']);
    expect(f.prisma.orderLine.findMany.mock.calls[0][0].where).toMatchObject({ orderId: 'O_OWN', order: { deletedAt: null } }); noWrite(f);
  });
  it('blank filter means all visible rows; deleted parent remains excluded', async () => {
    const f = fixture(), response = await read(f, '?orderId=%20%20'); expect(response.status).toBe(200);
    expect(f.prisma.orderLine.findMany.mock.calls[0][0].where.orderId).toBeUndefined(); expect(response.body.lines.some((line: any) => line.orderId === 'O_DELETED')).toBe(false); noWrite(f);
  });
  it('shared customer removal takes effect on the next read without the 60-second cache', async () => {
    const f = fixture(); f.share(); const first = await read(f, '?orderId=O_SHARED'); expect(first.status).toBe(200); expect(first.body.lines).toHaveLength(2);
    f.revokeShare(); const second = await read(f, '?orderId=O_SHARED'); expect(second.status).toBe(200); expect(second.body.lines).toEqual([]);
    expect(f.prisma.teamDataGrant.findMany).toHaveBeenCalledTimes(2); noWrite(f);
  });
  it.each(['absent', 'inactive', 'deleted'])('current %s user is refused before source query', async state => {
    const f = fixture(); f.current(state === 'absent' ? null : { ...account(), ...(state === 'inactive' ? { status: 'inactive' } : { deletedAt: 1 }) });
    const response = await read(f); expect(response.status).toBe(401); expect(code(response)).toBe('ACCOUNT_DISABLED'); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it.each(['expired', 'inactive', 'deleted', 'active'])('personal read grant %s uses actual effective-grant query conditions', async state => {
    const f = fixture(); f.current(account([])); f.override([{ userId, scope: 'orders:read', isActive: state !== 'inactive',
      deletedAt: state === 'deleted' ? new Date() : null, expiresAt: state === 'expired' ? new Date(0) : new Date(Date.now() + 60_000) }]);
    const response = await read(f); expect(response.status).toBe(state === 'active' ? 200 : 403);
    if (state !== 'active') expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it.each(['userAccount', 'userPermissionOverrides', 'teamMember', 'teamDataGrant', 'relation'])('%s read fault is explicit 503/no data/default grant', async model => {
    const f = fixture(); if (model === 'teamDataGrant') f.share();
    f.prisma[model][model === 'userAccount' ? 'findFirst' : 'findMany'].mockRejectedValue(Error('sensitive SQL detail must not reach client'));
    const response = await read(f); expect(response.status, JSON.stringify(response.body)).toBe(503); expect(code(response)).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('sensitive SQL'); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled(); noWrite(f);
  });
  it('a custom role named owner with real read grants gets only its actual self L2', async () => {
    const f = fixture(), user = account(['orders:read'], 'custom-role-named-owner'); user.roles[0].role.name = 'owner';
    f.current(user); const response = await read(f);
    expect(response.status).toBe(200); expect(response.body.lines.map((line: any) => line.orderId)).toEqual(['O_OWN', 'O_OWN', 'O_LEGACY', 'O_LEGACY']); noWrite(f);
  });
  it('actual admin all-scope read keeps the historical parent filter shape without omitting deletedAt', async () => {
    const f = fixture(); f.current(account(['orders:read'], 'role-admin')); const response = await read(f);
    expect(response.status).toBe(200); expect(response.body.lines).toHaveLength(8);
    expect(f.prisma.orderLine.findMany.mock.calls[0][0].where).toEqual({ order: { deletedAt: null } }); noWrite(f);
  });
});
