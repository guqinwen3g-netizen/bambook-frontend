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
  return { app, prisma, tx, current, prior, changed, token: createAuthService().signToken(prior) };
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

describe('production-batch HTTP permission prefilter (actual guards/services; substituted storage)', () => {
  const missingScopes = actions.flatMap(action => action.required.map(scope => ({ action, scope })));
  it.each(missingScopes)('$action.name refuses missing $scope before service transaction despite stale JWT permissions', async ({ action, scope }) => {
    const source = host({ scopes: fullScopes.filter(value => value !== scope) });
    const response = await post(source, action);
    expect(response.status).toBe(403); expect(response.body.error).toBe('FORBIDDEN'); expect(response.body.message).toContain(scope);
    expect(source.current.userAccount.findFirst).toHaveBeenCalledTimes(1); expect(source.current.userPermissionOverrides.findMany).toHaveBeenCalledTimes(1);
    expect(source.prisma.$transaction).not.toHaveBeenCalled(); noWrites(source);
  });
  it.each(actions)('$name rejects a fully scoped, mapped API key and body actor in its JWT-only write path', async action => {
    const source = host();
    const response = await request(source.app).post('/production-batches' + action.path).set('x-bambook-api-key', apiKey)
      .send({ ...action.body, actor: { userId: 'forged-owner', roles: ['owner'], permissions: ['*'] }, actorId: 'forged-owner' });
    expect(response.status).toBe(401); expect(response.body.error).toBe('UNAUTHORIZED');
    expect(source.current.userAccount.findFirst).toHaveBeenCalledTimes(1); expect(source.prisma.$transaction).not.toHaveBeenCalled(); noWrites(source);
  });
  it.each(actions.flatMap(action => [true, false].map(requireAuth => ({ action, requireAuth }))))(
    '$action.name rejects anonymous body identity when requireAuth=$requireAuth', async ({ action, requireAuth }) => {
      const source = host({ requireAuth });
      const response = await request(source.app).post('/production-batches' + action.path)
        .send({ ...action.body, actor: { ...source.prior, userId: 'forged-owner', roles: ['owner'], permissions: ['*'] }, actorId: 'forged-owner' });
      expect(response.status).toBe(401); expect(response.body.error).toBe('UNAUTHORIZED');
      expect(source.current.userAccount.findFirst).not.toHaveBeenCalled(); expect(source.prisma.$transaction).not.toHaveBeenCalled(); noWrites(source);
    });
  it.each(actions)('$name refuses a signed empty ceiling before the service transaction', async action => {
    const source = host(), token = createAuthService().signToken({ ...source.prior, permissionCeiling: [] });
    const response = await post(source, action, token);
    expect(response.status).toBe(403); expect(response.body.error).toBe('FORBIDDEN');
    expect(source.prisma.$transaction).not.toHaveBeenCalled(); noWrites(source);
  });
  it.each(actions)('$name accepts current scopes without production:write and reaches actual service scope lookup', async action => {
    const source = host(), response = await post(source, action);
    expect(response.status).toBe(404); expect(response.body).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND', status: 404 } });
    expect(source.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(source.tx.userAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: source.prior.userId, deletedAt: null } }));
    expect(source.tx.userPermissionOverrides.findMany).toHaveBeenCalledTimes(2);
    for (const readNumber of [1, 2]) expect(source.tx.userPermissionOverrides.findMany).toHaveBeenNthCalledWith(readNumber, {
      where: { userId: source.prior.userId, isActive: true, deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }, select: { scope: true },
    });
    expect(source.tx.userAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(source.tx.userAccount.findUnique).toHaveBeenCalledWith({ where: { id: source.prior.userId, deletedAt: null },
      select: { id: true, primaryDeptId: true, status: true, roles: { select: { departmentId: true,
        role: { select: { id: true, permissions: { select: { permission: { select: { scope: true } } } } } } } } },
    });
    expect(source.tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'prefilter-order', deletedAt: null, AND: expect.any(Array) }) }));
    noWrites(source);
  });
  it.each(actions)('$name retains real service rejection when the current grant is withdrawn inside its transaction', async action => {
    const source = host({ txScopes: action.name === 'receive' ? ['orders:read'] : [] }), response = await post(source, action);
    expect(response.status).toBe(403); expect(response.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(source.prisma.$transaction).toHaveBeenCalledTimes(1); expect(source.tx.userAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(source.tx.userPermissionOverrides.findMany).toHaveBeenCalledTimes(1); expect(source.tx.order.findFirst).not.toHaveBeenCalled(); noWrites(source);
  });
  it.each(actions.filter(action => action.name !== 'receive'))('$name retains the actual service leadership gate even with current orders:write', async action => {
    const source = host({ txRoleId: 'role-custom-batch-writer' }), response = await post(source, action);
    expect(response.status).toBe(403); expect(response.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(source.prisma.$transaction).toHaveBeenCalledTimes(1); expect(source.tx.userAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(source.tx.order.findFirst).not.toHaveBeenCalled(); noWrites(source);
  });
});
