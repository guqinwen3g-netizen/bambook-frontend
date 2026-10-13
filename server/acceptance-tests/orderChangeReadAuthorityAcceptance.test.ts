/** Isolated real HTTP + PostgreSQL. Only identity/share configuration is seeded;
 * orders, lines, main approvals and CR frozen payloads use actual producers. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createOrderChangeRouter } from '../src/orderChanges/orderChangeRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { registerNewDomainQueryTools } from '../src/agent/newDomainQueryTools';
import { dispatchFromRegistry, type ToolExecutionContext } from '../src/agent/toolDispatchRegistry';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, requireHttpSuccess, type BusinessFixtureActorName,
  type GlobalBusinessHttpFixture } from './globalBusinessFixtures';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture;
const enc = encodeURIComponent;
const changes = (id?: string) => `/api/v1/order-changes${id ? `/${enc(id)}` : ''}`;
const approvals = (id?: string, suffix = '') => `/api/v1/approvals${id ? `/${enc(id)}` : ''}${suffix}`;
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: `cr-read-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options)); app.use('/api/v1/order-changes', createOrderChangeRouter(options));
    app.use('/api/v1/approvals', createApprovalRouter({ prisma, requireAuth: true }));
  } });
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'fabric',
    userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
  const account = await prisma.userAccount.findUniqueOrThrow({ where: { id: f.actors.salesOwner.id } });
  await prisma.department.update({ where: { id: account.primaryDeptId! }, data: { headId: f.actors.manager.id } });
  registerNewDomainQueryTools();
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

async function draft(label: string, actor: 'salesOwner' | 'salesOutsider' = 'salesOwner', customer = f.customer) {
  const created = requireHttpSuccess(await f.request(actor, 'post', '/api/v1/orders', {
    customer: customer.name, customerRelationId: customer.id, product: `Exact read ${label}`, type: 'Fabric', businessLine: 'fabric',
    quantity: '1000', unit: 'm', dueDate: '2099-01-01', quoteAmount: '2500', currency: 'USD', paymentInstrument: 'T/T',
    ...(actor === 'salesOwner' ? { millRelationId: f.factory.id, millName: f.factory.name } : {}),
  }), 'create actual manual order').order;
  const line = requireHttpSuccess(await f.request(actor, 'post', '/api/v1/order-lines', {
    orderId: created.id, description: created.product, quantity: '1000', unit: 'm', unitPrice: '2.5',
  }), 'create actual product line').line;
  expect(line.orderId).toBe(created.id);
  return { orderId: created.id as string, lineId: line.id as string };
}
async function formal(label: string) {
  const source = await draft(label);
  const submitted = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v2/orders/${enc(source.orderId)}/submit-main-approval`, {}),
    'submit exact formal contract', 201).item;
  const reviewed = requireHttpSuccess(await f.request('manager', 'get', approvals(submitted.id)), 'read actual main approval', 200, false).item;
  const decided = requireHttpSuccess(await f.request('manager', 'post', approvals(reviewed.id, '/decide'), {
    status: 'approved', confirmedReviewedContent: true, reviewContentVersion: reviewed.reviewContentVersion,
  }), 'approve actual formal contract', 200, false).item;
  expect(decided).toMatchObject({ id: reviewed.id, status: 'approved', businessSyncStatus: 'completed' });
  const current = requireHttpSuccess(await f.request('salesOwner', 'get', `/api/v1/orders/${enc(source.orderId)}`), 'read formal order').order;
  expect(current.status).toBe('Confirmed');
  return source;
}
async function change(source: Awaited<ReturnType<typeof draft>>, extraFrozenSource?: Awaited<ReturnType<typeof draft>>) {
  const result = requireHttpSuccess(await f.request('salesOwner', 'post', changes(), {
    orderId: source.orderId, changeType: 'price', beforeSnapshot: { unitPrice: '2500',
      ...(extraFrozenSource ? { sourceProofs: [{ orderId: extraFrozenSource.orderId, orderLineId: extraFrozenSource.lineId,
        note: 'ISOLATED-HIDDEN-FROZEN-SOURCE' }] } : {}) }, afterDelta: { unitPrice: '2600' },
    changeReason: '客户依据修订资料要求调整当前订单金额并保留变更历史',
    impactSummary: '本次变更影响合同金额，未改变已完成的生产与履约事实',
  }), 'create native frozen change request', 201, false);
  expect(result.changeRequest).toMatchObject({ orderId: source.orderId, status: 'Pending', approvalRequestId: result.approvalRequestId });
  const stored = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: result.approvalRequestId } });
  expect(stored).toMatchObject({ actionType: 'order:change', targetType: 'OrderChangeRequest', targetId: source.orderId,
    requesterId: f.actors.salesOwner.id, reviewerId: f.actors.manager.id });
  return { id: result.changeRequest.id as string, approvalId: result.approvalRequestId as string };
}
async function currentActor(name: BusinessFixtureActorName): Promise<TokenPayload> {
  const account = await loadUserWithRoles(prisma, f.actors[name].id);
  if (!account) throw Error('ACTUAL_ACCOUNT_MISSING');
  return buildLoadedAuthTokenPayload(prisma, account);
}
function toolContext(actor: TokenPayload): ToolExecutionContext {
  return { actor: { userId: actor.userId, roles: actor.roles, departmentIds: actor.departmentIds,
    permissionScopes: actor.permissions, permissionsAuthoritative: true, permissionCeiling: actor.permissionCeiling,
    toolScopes: [], memoryScopes: [], knowledgeScopes: [] } };
}
async function agent(actor: TokenPayload, input: Record<string, unknown>) {
  const response = await dispatchFromRegistry(prisma, { toolId: 'order_changes.query', input }, toolContext(actor));
  if (!response.hit) throw Error('REAL_QUERY_TOOL_NOT_REGISTERED');
  return response.result;
}

describe('native CR HTTP, Agent and frozen approval reads share current complete parent authority', () => {
  it('allows the real source business and hides every endpoint until all frozen parent sources are currently visible', async () => {
    const source = await formal('full-source'), own = await change(source);
    const detail = requireHttpSuccess(await f.request('salesOwner', 'get', changes(own.id)), 'read legitimate change', 200, false).item;
    expect(detail).toMatchObject({ id: own.id, order: { id: source.orderId }, approvalRequest: { id: own.approvalId } });
    expect(detail.approvalRequest.payload).toBeUndefined();
    expect(requireHttpSuccess(await f.request('salesOutsider', 'get', changes()), 'foreign scoped list', 200, false).items).toEqual([]);
    expect((await f.request('salesOutsider', 'get', changes(own.id))).status).toBe(404);
    expect(await agent(await currentActor('salesOwner'), { id: own.id })).toMatchObject({ ok: true, item: { id: own.id } });
    expect(await agent(await currentActor('salesOutsider'), { id: own.id })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    for (const suffix of ['', '/detail']) {
      requireHttpSuccess(await f.request('salesOwner', 'get', approvals(own.approvalId, suffix)), 'source requester reads frozen approval', 200, false);
      expect((await f.request('salesOutsider', 'get', approvals(own.approvalId, suffix))).status).toBe(404);
    }
    const owner = await prisma.userAccount.findUniqueOrThrow({ where: { id: f.actors.salesOutsider.id } });
    const hiddenCustomer = await prisma.relation.create({ data: { id: `${f.prefix}-hidden-customer`, code: `${f.prefix}-hidden-customer`,
      name: `${f.prefix} private customer`, category: 'Customer', type: 'company', isOrganization: true, contactInfo: '{}',
      tags: ['ISOLATED_ACCEPTANCE'], lastInteraction: BigInt(Date.now()), ownerId: owner.id, departmentId: owner.primaryDeptId,
      salesRepIds: [owner.id], factoryAddresses: [] } });
    const hidden = await draft('foreign-parent', 'salesOutsider', hiddenCustomer);
    const mixedSource = await formal('mixed-source'), mixed = await change(mixedSource, hidden);
    const frozen = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: mixed.approvalId } });
    expect(frozen.payload).toMatchObject({ beforeSnapshot: { sourceProofs: [{ orderId: hidden.orderId, orderLineId: hidden.lineId }] } });
    expect((await f.request('salesOwner', 'get', changes(mixed.id))).status).toBe(404);
    const visible = requireHttpSuccess(await f.request('salesOwner', 'get', changes()), 'list omits partially visible frozen source', 200, false).items;
    expect(visible.map((row: { id: string }) => row.id)).toContain(own.id); expect(visible.map((row: { id: string }) => row.id)).not.toContain(mixed.id);
    expect(await agent(await currentActor('salesOwner'), { id: mixed.id })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    for (const suffix of ['', '/detail']) {
      const denied = await f.request('salesOwner', 'get', approvals(mixed.approvalId, suffix));
      expect(denied.status).toBe(403); expect(JSON.stringify(denied.body)).not.toContain('ISOLATED-HIDDEN-FROZEN-SOURCE');
    }
    const pending = requireHttpSuccess(await f.request('manager', 'get', approvals()), 'approver scoped frozen list', 200, false).items;
    expect(pending.map((row: { id: string }) => row.id)).toContain(own.approvalId);
    expect(pending.map((row: { id: string }) => row.id)).not.toContain(mixed.approvalId);
    const grant = await prisma.teamDataGrant.create({ data: { teamId: f.teamIds.fabric, entityType: 'relation', entityId: hiddenCustomer.id,
      permission: 'read', grantedBy: f.actors.manager.id } });
    try {
      const readable = requireHttpSuccess(await f.request('salesOwner', 'get', changes(mixed.id)), 'read after actual full-parent grant', 200, false).item;
      expect(readable.id).toBe(mixed.id);
      for (const suffix of ['', '/detail']) requireHttpSuccess(await f.request('salesOwner', 'get', approvals(mixed.approvalId, suffix)),
        'read original frozen approval after exact current source grant', 200, false);
      expect(await agent(await currentActor('salesOwner'), { id: mixed.id })).toMatchObject({ ok: true, item: { id: mixed.id } });
      expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: mixed.approvalId } })).payload).toEqual(frozen.payload);
    } finally { await prisma.teamDataGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } }); }
    expect((await f.request('salesOwner', 'get', changes(mixed.id))).status).toBe(404);
  }, 120_000);

  it('old signed sessions lose reads immediately on ceiling, share/role withdrawal or account disablement', async () => {
    const source = await formal('fresh-authority'), cr = await change(source), originalActor = await currentActor('salesOwner');
    const limited = { ...f.actors.salesOwner, token: createAuthService().signToken({ ...originalActor, permissionCeiling: ['order:change_request:create'] }) };
    for (const url of [changes(), changes(cr.id), approvals(cr.approvalId), approvals(cr.approvalId, '/detail')])
      expect((await f.request(limited, 'get', url)).status).toBe(403);
    await expect(agent({ ...originalActor, permissionCeiling: [] }, { id: cr.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sharedBefore = requireHttpSuccess(await f.request('actualRequester', 'get', changes(cr.id)), 'actual active team read', 200, false).item;
    expect(sharedBefore.id).toBe(cr.id);
    const grants = await prisma.teamDataGrant.findMany({ where: { entityId: f.customer.id, teamId: { in: Object.values(f.teamIds) }, revokedAt: null } });
    await prisma.teamDataGrant.updateMany({ where: { id: { in: grants.map(row => row.id) } }, data: { revokedAt: new Date() } });
    try {
      expect((await f.request('actualRequester', 'get', changes(cr.id))).status).toBe(404);
      expect(await agent(await currentActor('actualRequester'), { id: cr.id })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    } finally { for (const grant of grants) await prisma.teamDataGrant.update({ where: { id: grant.id }, data: { revokedAt: grant.revokedAt } }); }
    const roles = await prisma.userRole.findMany({ where: { userId: originalActor.userId } });
    await prisma.userRole.deleteMany({ where: { userId: originalActor.userId } });
    try {
      for (const url of [changes(), changes(cr.id), approvals(cr.approvalId), approvals(cr.approvalId, '/detail')])
        expect((await f.request('salesOwner', 'get', url)).status).toBe(403);
      await expect(agent(originalActor, { id: cr.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally { await prisma.userRole.createMany({ data: roles }); }
    await prisma.userAccount.update({ where: { id: originalActor.userId }, data: { status: 'disabled' } });
    try {
      for (const url of [changes(), changes(cr.id), approvals(cr.approvalId), approvals(cr.approvalId, '/detail')])
        expect((await f.request('salesOwner', 'get', url)).status).toBe(401);
      await expect(agent(originalActor, { id: cr.id })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    } finally { await prisma.userAccount.update({ where: { id: originalActor.userId }, data: { status: 'active' } }); }
    expect(requireHttpSuccess(await f.request('salesOwner', 'get', changes(cr.id)), 'legal source read restored with unchanged frozen facts', 200, false).item.id).toBe(cr.id);
  }, 120_000);
});
