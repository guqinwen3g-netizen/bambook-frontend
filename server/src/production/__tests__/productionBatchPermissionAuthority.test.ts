/** Actual middleware/current auth/services; substituted native storage only. No PG business facts, authority helper mocks or production mutations. */
/** Route prefilter and actual service authorization controls. JWT verification,
 * snapshot loading, permission guards and production services are real. Only
 * Prisma storage delegates are substituted; no Prisma client connects to PG.
 * An eligible transport reaches the real service and a missing scoped Order
 * refuses it. This does not prove a successful native batch/stock write, locks,
 * rollback, receipts, QC/release eligibility or complete business-role UAT. */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { getDefaultAgentApiKeyActors, setDefaultAgentApiKeyActors } from '../../auth/agentPrincipal';
import { createProductionBatchRouter } from '../productionBatchRoute';

const fullScopes = ['orders:read', 'orders:write', 'inventory:write'];
const apiKey = 'synthetic-production-prefilter-api-key';
const originalActors = new Map(getDefaultAgentApiKeyActors());
afterEach(() => setDefaultAgentApiKeyActors(new Map(originalActors)));
const fingerprint = 'a'.repeat(64);
const actions = [
  { name: 'create', path: '/orders/prefilter-order/lines/prefilter-line', required: ['orders:write'], body: {
    batchCode: 'PREFILTER-ONLY', quantity: '1.2500', unit: 'm', expectedLineFingerprint: fingerprint, requestKey: 'prefilter-create' } },
  { name: 'split', path: '/prefilter-batch/split', required: ['orders:write'], body: {
    expectedRevision: 1, expectedLineFingerprint: fingerprint, requestKey: 'prefilter-split',
    children: [{ batchCode: 'PREFILTER-A', quantity: '0.5000' }, { batchCode: 'PREFILTER-B', quantity: '0.7500' }] } },
  { name: 'receive', path: '/prefilter-batch/stock-receipts', required: ['orders:read', 'inventory:write'], body: {
    expectedBatchRevision: 1, expectedScopeFingerprint: fingerprint, warehouseId: 'prefilter-warehouse', quantity: '1.2500',
    unit: 'm', movementDate: '2099-01-01', receiptReference: 'Pure transport input, no receipt fact', ownership: 'Owned',
    unitCost: null, currency: 'USD', requestKey: 'prefilter-receive' } },
] as const;
type Action = typeof actions[number];

function account(scopes: readonly string[], roleId = 'manager') {
  return { id: 'synthetic-production-prefilter-user', displayName: 'Synthetic prefilter user',
    email: 'production-prefilter@acceptance.invalid', status: 'active', deletedAt: null,
    primaryDeptId: null, primaryDepartment: null,
    roles: [{ roleId, departmentId: null, role: { id: roleId, name: roleId, isSystem: roleId === 'manager',
      permissions: scopes.map(scope => ({ permission: { scope } })) } }],
  };
}
function authStorage(user: ReturnType<typeof account>) {
  return { userAccount: { findFirst: vi.fn(async () => user),
    findUnique: vi.fn(async ({ where }: any) => where.id === user.id && where.deletedAt === null && user.deletedAt == null ? user : null) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) } };
}
function host(options: { scopes?: readonly string[]; txScopes?: readonly string[]; txRoleId?: string; requireAuth?: boolean } = {}) {
  const user = account(options.scopes ?? fullScopes), current = authStorage(user);
  const txUser = account(options.txScopes ?? options.scopes ?? fullScopes, options.txRoleId ?? 'manager');
  // The hint supplies neutral identifiers only; it is not a stock, approved
  // source, release, receipt or financial fact. Actual scope lookup stops here.
  const tx = { ...authStorage(txUser),
    productionBatch: { findUnique: vi.fn(async () => ({ id: 'prefilter-batch', orderId: 'prefilter-order', orderLineId: 'prefilter-line' })),
      create: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(async () => null) },
    relation: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn(async () => []) },
    inventoryItem: { create: vi.fn(), update: vi.fn() }, productionStockReceipt: { create: vi.fn(), update: vi.fn() },
    stockMovement: { create: vi.fn() }, auditLog: { create: vi.fn() }, $queryRaw: vi.fn(),
  };
  const prisma = { ...current, $transaction: vi.fn(async (work: (storage: typeof tx) => Promise<unknown>) => work(tx)) };
  const prior: TokenPayload = { userId: user.id, displayName: user.displayName, roles: ['manager'], roleIds: ['manager'],
    permissions: [...fullScopes, 'production:write'], departmentIds: ['company'], authorizationLoaded: true };
  setDefaultAgentApiKeyActors(new Map([[apiKey, { ...prior, displayName: user.displayName }]]));
  const changed = vi.fn(), app = express(); app.use(express.json());
  app.use(createAuthorizationSnapshotGuard({ prisma: prisma as any, apiKeys: new Set([apiKey]), apiKeyActors: getDefaultAgentApiKeyActors() as any }));
  app.use('/production-batches', createProductionBatchRouter({ prisma: prisma as any,
    requireAuth: options.requireAuth ?? true, apiKeys: new Set([apiKey]), onDataChange: changed }));
  return { app, prisma, tx, current, prior, changed, txUser, token: createAuthService().signToken(prior) };
}
function post(source: ReturnType<typeof host>, action: Action, token = source.token) {
  return request(source.app).post('/production-batches' + action.path).set('Authorization', `Bearer ${token}`).send(action.body);
}
function noWrites(source: ReturnType<typeof host>) {
  expect(source.tx.productionBatch.create).not.toHaveBeenCalled(); expect(source.tx.productionBatch.update).not.toHaveBeenCalled();
  expect(source.tx.inventoryItem.create).not.toHaveBeenCalled(); expect(source.tx.inventoryItem.update).not.toHaveBeenCalled();
  expect(source.tx.productionStockReceipt.create).not.toHaveBeenCalled(); expect(source.tx.productionStockReceipt.update).not.toHaveBeenCalled();
  expect(source.tx.stockMovement.create).not.toHaveBeenCalled(); expect(source.tx.auditLog.create).not.toHaveBeenCalled();
  expect(source.tx.$queryRaw).not.toHaveBeenCalled(); expect(source.changed).not.toHaveBeenCalled();
}


// Native query matching only; actual current grant/L2 policy constructs every
// where. This neutral fixture has no approval, eligibility, stock or receipt fact.
function storageMatches(row: Record<string, unknown>, where: any): boolean {
  if (where.AND && !(Array.isArray(where.AND) ? where.AND : [where.AND]).every((part: any) => storageMatches(row, part))) return false;
  if (where.OR && !where.OR.some((part: any) => storageMatches(row, part))) return false;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR') continue;
    if (value && typeof value === 'object') {
      if (Object.keys(value).length !== 1 || !('in' in value) || !Array.isArray((value as any).in)) throw new Error('unsupported synthetic native where');
      if (!(value as any).in.includes(row[key])) return false;
    } else if (row[key] !== value) return false;
  }
  return true;
}
function noBusinessWrites(source: ReturnType<typeof host>) {
  expect(source.tx.productionBatch.create).not.toHaveBeenCalled(); expect(source.tx.productionBatch.update).not.toHaveBeenCalled();
  expect(source.tx.inventoryItem.create).not.toHaveBeenCalled(); expect(source.tx.inventoryItem.update).not.toHaveBeenCalled();
  expect(source.tx.productionStockReceipt.create).not.toHaveBeenCalled(); expect(source.tx.productionStockReceipt.update).not.toHaveBeenCalled();
  expect(source.tx.stockMovement.create).not.toHaveBeenCalled(); expect(source.tx.auditLog.create).not.toHaveBeenCalled();
  expect(source.changed).not.toHaveBeenCalled();
}
describe('Production permission current native storage readers through actual HTTP', () => {
  it.each(actions)('$name original missing current-account delegate fails closed before scoped Order', async action => {
    const source = host(); delete (source.tx.userAccount as any).findUnique;
    const response = await post(source, action);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE', status: 503 } });
    expect(source.tx.userAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(source.tx.userPermissionOverrides.findMany).toHaveBeenCalledTimes(1);
    expect(source.tx.order.findFirst).not.toHaveBeenCalled(); noWrites(source);
  });
  it.each(actions)('$name one missing storage delegate restored reaches missing Order and rereads current grants', async action => {
    const source = host();
    const findUnique = source.tx.userAccount.findUnique;
    const response = await post(source, action);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND', status: 404 } });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: source.prior.userId, deletedAt: null } }));
    expect(source.tx.userAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(source.tx.userPermissionOverrides.findMany).toHaveBeenCalledTimes(2);
    expect(source.tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'prefilter-order', deletedAt: null, AND: expect.any(Array) }) }));
    noWrites(source);
  });
  it.each(actions)('$name actual current-account dependency fault remains503 and does not become a missing Order', async action => {
    const source = host();
    (source.tx.userAccount as any).findUnique = vi.fn(async () => { throw new Error('synthetic exact current L2 storage read fault'); });
    const response = await post(source, action);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE', status: 503 } });
    expect(source.tx.order.findFirst).not.toHaveBeenCalled(); noWrites(source);
  });
});


describe('Production permission current-account and post-lock grant denial', () => {
  it.each(actions.flatMap(action => ['inactive','deleted'].map(kind => ({ action, kind }))))(
    '$action.name current transaction $kind account is denied despite earlier loaded JWT and middleware scopes', async ({ action, kind }) => {
      const source = host();
      if (kind === 'inactive') source.txUser.status = 'inactive'; else (source.txUser as any).deletedAt = BigInt(1);
      const response = await post(source, action);
      expect(response.status).toBe(401); expect(response.body).toMatchObject({ ok: false, error: { code: 'ACCOUNT_DISABLED', status: 401 } });
      expect(source.current.userAccount.findFirst).toHaveBeenCalledTimes(1); expect(source.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(source.tx.userAccount.findFirst).toHaveBeenCalledTimes(1); expect(source.tx.userPermissionOverrides.findMany).not.toHaveBeenCalled();
      expect(source.tx.userAccount.findUnique).not.toHaveBeenCalled(); expect(source.tx.order.findFirst).not.toHaveBeenCalled(); noWrites(source);
    });
  it.each(actions)('$name current personal grant withdrawn after actual service lock prelude refuses before any native business write', async action => {
    const source = host({ txScopes: [] }), tx = source.tx as any;
    const order = { id: 'prefilter-order', deletedAt: null, customerRelationId: null, ownerId: source.prior.userId };
    const line = { id: 'prefilter-line', orderId: order.id, materialCode: null, confirmedSourceType: null, confirmedSourceId: null, specSnapshot: null, quantity: '1.25', unit: 'm' };
    tx.order.findFirst.mockImplementation(async ({ where }: any) => storageMatches(order, where) ? order : null);
    tx.orderLine = { findMany: vi.fn(async ({ where }: any) => storageMatches(line, where) ? [line] : []),
      findUnique: vi.fn(async ({ where }: any) => where.id === line.id ? line : null) };
    tx.releaseScope = { findMany: vi.fn(async () => []) };
    tx.$queryRaw.mockImplementation(async (sql: any) => {
      if (!sql.sql?.includes('FOR UPDATE')) throw new Error('unexpected synthetic native query');
      return sql.sql.includes('"OrderLine"') ? [{ id: line.id }] : [{ id: order.id }];
    });
    const rawCallsAtGrants: number[] = [];
    tx.userPermissionOverrides.findMany.mockImplementation(async () => {
      rawCallsAtGrants.push(tx.$queryRaw.mock.calls.length);
      return rawCallsAtGrants.length < 3 ? fullScopes.map(scope => ({ scope })) : [];
    });
    const response = await post(source, action);
    expect(response.status).toBe(403); expect(response.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(source.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.userAccount.findFirst).toHaveBeenCalledTimes(2); expect(tx.userAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.userPermissionOverrides.findMany).toHaveBeenCalledTimes(3);
    expect(rawCallsAtGrants.slice(0,2)).toEqual([0,0]); expect(rawCallsAtGrants[2]).toBeGreaterThan(0);
    for (const readNumber of [1,2,3]) expect(tx.userPermissionOverrides.findMany).toHaveBeenNthCalledWith(readNumber, {
      where: { userId: source.prior.userId, isActive: true, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }, select: { scope: true },
    });
    expect(tx.order.findFirst).toHaveBeenCalledTimes(1); noBusinessWrites(source);
  });
});
