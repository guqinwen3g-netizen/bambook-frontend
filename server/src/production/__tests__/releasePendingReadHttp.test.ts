/** Actual release router/service + JWT verification/current account guard.
 * Only native storage delegates are substituted. No DB, native locks or UAT.
 * Synthetic scope is unapproved/dangling; no approved financial/stock facts. */
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { createReleaseRouter } from '../releaseRoute';
const grants = ['production:read', 'orders:write', 'production:pp_release:business_sign', 'production:pp_release:production_sign'];
function account(scopes = grants) {
  return { id: 'release-current', displayName: 'Current synthetic principal', status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'manager', departmentId: null, role: { id: 'manager', name: 'manager', isSystem: true,
      permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
}
function host(options: { fault?: boolean; scopes?: string[]; ceiling?: string[]; validCreateScope?: boolean } = {}) {
  let current = account(options.scopes ?? grants);
  // RHTTP09 is the one positive create path. Give it a real parent order with
  // its actual active line and write-once MOQ snapshot; the default host keeps
  // its missing-line behavior for every refusal test.
  const activeOrderLine = { id: 'L-original', orderId: 'O-original', lineNumber: 1, quantity: '1000', unit: 'M',
    moqOverride: null, materialCode: null, fabricCode: null, confirmedSourceType: null, confirmedSourceId: null, specSnapshot: null };
  const parent = { id: 'O-original', deletedAt: null, customerRelationId: null, ownerId: current.id, millRelationId: null, sourceCaseId: null,
    type: 'Fabric', businessLine: 'fabric', capsuleExemption: false,
    moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
      snapshotAt: '2026-10-04T00:00:00.000Z', configId: null, source: 'fallback_constant' } };
  const scope = { id: 'RS-original', orderId: 'O-original', orderLineId: 'L-original', scopeRevision: 1,
    state: 'no_release', currentReleaseId: null, confirmedSourceType: null, confirmedSourceId: null, deletedAt: null };
  // Real loaders still decide L2; this native storage predicate only applies
  // their resulting query, never returns a fabricated authorization result.
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === 'OR') return value.some((item: any) => matches(row, item));
    if (value && typeof value === 'object' && Array.isArray(value.in)) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'not')) return (row[key] ?? null) !== value.not;
    return (row[key] ?? null) === value;
  });
  const storage: any = {
    userAccount: { findFirst: vi.fn(async () => current), findUnique: vi.fn(async ({ where }: any) => where.id === current.id && current.deletedAt == null ? current : null) }, userPermissionOverrides: { findMany: vi.fn(async () => []) },
    order: { findFirst: vi.fn(async ({ where }: any) => matches(parent, where) ? parent : null),
      findUnique: vi.fn(async ({ where }: any) => options.validCreateScope && where.id === parent.id
        ? { ...parent, lines: [activeOrderLine] } : null) },
    relation: { findMany: vi.fn(async () => []) }, teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []) },
    releaseScope: { findMany: vi.fn(async () => [scope]), findFirst: vi.fn(async ({ where }: any) => matches(scope, where) ? scope : null) },
    orderLine: { findUnique: vi.fn(async ({ where }: any) => options.validCreateScope && where.id === activeOrderLine.id ? activeOrderLine : null),
      findMany: vi.fn(async ({ where }: any) => options.validCreateScope && (where?.orderId === parent.id || where?.orderId?.in?.includes(parent.id)) ? [activeOrderLine] : []) },
    releaseRequest: { findMany: vi.fn(async () => { if (options.fault) throw new Error('SQL SECRET internal /private/path stack');
      return [{ id: 'RR-original', scopeId: scope.id, state: 'pending', createdBy: current.id }]; }),
      findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) },
    releaseEvent: { create: vi.fn() }, releaseSignature: { create: vi.fn() }, ppSampleRelease: { create: vi.fn() },
    auditLog: { create: vi.fn() }, $queryRaw: vi.fn(async () => []),
  };
  storage.$transaction = vi.fn(async (work: any) => work(storage));
  const prior: TokenPayload = { userId: current.id, displayName: 'Old signed name', roles: ['manager'], roleIds: ['manager'],
    permissions: [...grants], departmentIds: ['company'], authorizationLoaded: true,
    ...(options.ceiling !== undefined ? { permissionCeiling: options.ceiling } : {}) };
  const app = express(); app.use(express.json());
  // Standalone host mirrors index.ts BigInt wire formatting without global mutation.
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  app.use(createAuthorizationSnapshotGuard({ prisma: storage }));
  const changed = vi.fn(); app.use('/api/v1/releases', createReleaseRouter({ prisma: storage, requireAuth: true, onDataChange: changed }));
  return { app, storage, changed, prior, token: createAuthService().signToken(prior), withdraw: (scopes: string[]) => { current = account(scopes); }, disable: () => { current.status = 'disabled'; } };
}
async function wire(h: ReturnType<typeof host>, method: 'get' | 'post', path: string, body?: unknown) {
  const server = createServer(h.app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const req = request(server)[method]('/api/v1/releases' + path).set('Authorization', 'Bearer ' + h.token);
    return await (body === undefined ? req : req.send(body));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const get = (h: ReturnType<typeof host>) => wire(h, 'get', '/orders/O-original/releases');
const post = (h: ReturnType<typeof host>, path: string, body: unknown) => wire(h, 'post', path, body);
function noWrite(h: ReturnType<typeof host>) {
  expect(h.storage.releaseRequest.create).not.toHaveBeenCalled(); expect(h.storage.releaseSignature.create).not.toHaveBeenCalled();
  expect(h.storage.ppSampleRelease.create).not.toHaveBeenCalled(); expect(h.storage.releaseEvent.create).not.toHaveBeenCalled(); expect(h.storage.auditLog.create).not.toHaveBeenCalled(); expect(h.changed).not.toHaveBeenCalled();
}
it('RHTTP01 pending native read failure returns safe failure rather than an empty pending success', async () => {
  const h = host({ fault: true }), r = await get(h); expect(r.status).toBe(500); expect(r.body.ok).toBe(false);
  expect(r.body.error.code).toBe('INTERNAL_ERROR'); expect(JSON.stringify(r.body)).not.toMatch(/SQL|SECRET|private\/path|stack/); noWrite(h);
});
it('RHTTP02 an actual authorized read preserves the original pending request and original scope projection', async () => {
  const h = host(), r = await get(h); expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, total: 1, ready: 0, blocked: 1,
    scopes: [{ id: 'RS-original', state: 'no_release' }], pendingRequests: [{ id: 'RR-original', scopeId: 'RS-original', state: 'pending' }] }); noWrite(h);
});
it.each([{ scopes: [] }, { scopes: ['orders:write'] }])('RHTTP03 current grant withdrawal $scopes cannot recover a read from the stale JWT', async ({ scopes }) => {
  const h = host(); h.withdraw(scopes); const r = await get(h); expect(r.status).toBe(403);
  expect(h.storage.releaseScope.findMany).not.toHaveBeenCalled(); noWrite(h);
});
it('RHTTP04 signed empty ceiling cannot recover current broad read grants', async () => {
  const h = host({ ceiling: [] }), r = await get(h); expect(r.status).toBe(403); expect(h.storage.releaseScope.findMany).not.toHaveBeenCalled(); noWrite(h);
});
it('RHTTP05 disabled current account rejects the old signed credential before reading release storage', async () => {
  const h = host(); h.disable(); const r = await get(h); expect(r.status).toBe(401); expect(h.storage.releaseScope.findMany).not.toHaveBeenCalled(); noWrite(h);
});
it.each(['/release-scopes/RS-original/requests', '/release-requests/RR-original/signatures'])('RHTTP06 readonly principal body forgery cannot reach %s writes', async path => {
  const h = host({ scopes: ['production:read'] }), r = await post(h, path, { role: 'business', actorId: 'forged-owner', actorName: 'Forged', actor: { userId: 'forged-owner', permissions: ['*'] } });
  expect(r.status).toBe(403); expect(h.storage.$transaction).not.toHaveBeenCalled(); noWrite(h);
});
it('RHTTP07 role-specific permission cannot be expanded by selecting the other signature role', async () => {
  const h = host({ scopes: ['production:read', 'production:pp_release:business_sign'] }), r = await post(h, '/release-requests/RR-original/signatures', { role: 'production', permissions: ['*'] });
  expect(r.status).toBe(403); expect(h.storage.$transaction).not.toHaveBeenCalled(); noWrite(h);
});
it('RHTTP08 allowed role reaches real request lookup and preserves missing-original refusal', async () => {
  const h = host({ scopes: ['production:read', 'production:pp_release:production_sign'] }), r = await post(h, '/release-requests/RR-original/signatures', {
    role: 'production', confirmedReviewedContent: true, expectedRequestRevision: 1, expectedScopeRevision: 1, reviewContentFingerprint: 'a'.repeat(64),
  });
  expect(r.status).toBe(404); expect(r.body.error.code).toBe('REQUEST_NOT_FOUND'); expect(h.storage.$transaction).toHaveBeenCalledTimes(1); noWrite(h);
});
it('RHTTP10 public signature without an explicit review confirmation is rejected before storage', async () => {
  const h = host({ scopes: ['production:read', 'production:pp_release:production_sign'] });
  const r = await post(h, '/release-requests/RR-original/signatures', { role: 'production' });
  expect(r.status).toBe(400); expect(r.body.error.code).toBe('REVIEW_CONFIRMATION_REQUIRED');
  expect(h.storage.$transaction).not.toHaveBeenCalled(); noWrite(h);
});
it('RHTTP09 actual create-request callback attributes the synthetic request to the trusted current actor, never body identity', async () => {
  const h = host({ validCreateScope: true }), r = await post(h, '/release-scopes/RS-original/requests', { expectedScopeRevision: 1, actorId: 'forged-owner', actorName: 'Forged', actor: { userId: 'forged-owner' } });
  expect(r.status).toBe(201); expect(r.body.request).toMatchObject({ scopeId: 'RS-original', createdBy: 'release-current', state: 'pending' });
  expect(h.storage.releaseRequest.create).toHaveBeenCalledTimes(1); expect(h.changed).toHaveBeenCalledWith(expect.objectContaining({ action: 'create_request' }));
});
