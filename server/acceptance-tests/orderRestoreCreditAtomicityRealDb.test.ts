/**
 * Opt-in independent PG restoration/credit probes. Rules: 审阅方更正件-S级复量-
 * 2026-09-25 §三 / A10-① §2.3 (only restore Confirmed runs its existing gates;
 * a preflight denial does not revoke rejection/withdrawal/cancellation),
 * 信用控制规则.md §13 and 审批与human-in-the-loop.md §15.3 B2/B5 + §15.4
 * (actual scoped pass + action + quota + mandatory audit share the business tx).
 *
 * Real PG, real HTTP/JWT middleware, canonical DB identity loading, services,
 * locks/CAS/FK rollback. Proxies inject ONLY real SQL FK failure or coordinate
 * a deadline/quota change after a real active-pass read. Approved exception
 * fixtures are synthetic committed facts, not company approval-policy proof.
 * No seed/index/scheduler/model/MCP/external action. This file does not prove
 * global fresh-auth, downstream delivery, credit Churned recovery, or UAT.
 * Global approval decisions and rejection notifications commit independently
 * BEFORE business projection; failed projection must preserve both and retry.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { createOrderChangeRequestService } from '../src/orderChanges/orderChangeRequestService';
import { createOrderChangeRouter } from '../src/orderChanges/orderChangeRoute';
import { createShippingRouter } from '../src/shipping/route';
import { businessEventBus, type BusinessEvent } from '../src/events/businessEventBus';
import { CREDIT_EXCEPTION_CONSUMPTION_CODES, CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS } from '../src/credit/creditExceptionGate';
import { httpStatusOfCode } from '../src/shared/errorCodes';

const prefix = `acceptance-order-restore-${randomUUID()}`;
const requesterId = `${prefix}-requester`, reviewerId = `${prefix}-reviewer`;
let prisma: PrismaClient | undefined, requester: TokenPayload, reviewer: TokenPayload;
let requesterToken: string, reviewerToken: string, sequence = 0;
const observed: BusinessEvent[] = [], ownShipments = new Set<string>();
let unsubscribe: (() => void) | undefined;
function db() { if (!prisma) throw Error('Independent restore client not initialized'); return prisma; }

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'verify independent PG before ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.createMany({ data: [requesterId, reviewerId].map(id => ({ id, displayName: id, status: 'active' })) });
  // Exact existing canonical role maps to manager in production tokenHelpers.
  // This is an isolated technical route fixture, not a company reviewer policy.
  await db().role.upsert({ where: { id: 'role-sales-manager' }, update: {},
    create: { id: 'role-sales-manager', name: 'Synthetic canonical manager', isSystem: true } });
  await db().userRole.create({ data: { id: `${prefix}-reviewer-role`, userId: reviewerId, roleId: 'role-sales-manager' } });
  await db().userPermissionOverrides.createMany({ data: ['orders:read', 'order:change_request:create', 'shipments:read', 'shipments:write'].map(scope => ({
    id: `${prefix}-grant-${scope}`, userId: requesterId, scope, grantedBy: reviewerId, isActive: true,
    reason: 'Synthetic isolated route grant, not company grant-policy proof',
  })) });
  requester = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), requesterId));
  reviewer = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), reviewerId));
  expect(requester).toMatchObject({ userId: requesterId, roles: [], authorizationLoaded: true });
  expect(reviewer).toMatchObject({ userId: reviewerId, roles: ['manager'], roleIds: ['role-sales-manager'], authorizationLoaded: true });
  requesterToken = createAuthService().signToken(requester); reviewerToken = createAuthService().signToken(reviewer);
  unsubscribe = businessEventBus.subscribe('*', event => { if (ownShipments.has(event.sourceEntityId)) observed.push(event); });
});
afterAll(async () => { unsubscribe?.(); await prisma?.$disconnect(); });

type Kind = 'rejection' | 'withdrawal' | 'shipping';
async function fixture(label: string, kind: Kind, fromStatus = 'Confirmed') {
  const id = `${prefix}-${++sequence}-${label}`, orderId = `${id}-order`, relationId = `${id}-relation`,
    creditId = `${id}-credit`, exceptionId = `${id}-exception`, exceptionApprovalId = `${id}-exception-approval`,
    changeId = `${id}-change`, approvalId = `${id}-change-approval`, shipmentId = `${id}-shipment`;
  const status = kind === 'shipping' ? 'Shipping' : kind === 'withdrawal' ? 'PauseRequested' : 'CancelRequested';
  const scope = { targetType: 'Order', targetId: orderId, action: 'order:confirm', responsibleOwnerId: requesterId,
    validUntil: new Date(Date.now() + 120_000).toISOString(), maxUses: 1, usedCount: 0, consumptions: [] };
  await db().$transaction(async tx => {
    await tx.relation.create({ data: { id: relationId, name: id, category: 'Customer', type: 'Company', isOrganization: true,
      tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: requesterId, salesRepIds: [] } });
    await tx.creditLimit.create({ data: { id: creditId, relationId, status: 'Frozen', totalLimit: 1_000_000, usedAmount: 0,
      currency: 'USD', validFrom: '2020-01-01', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    await tx.order.create({ data: { id: orderId, code: `${id}-code`, customer: id, product: 'Synthetic fabric', type: 'Fabric',
      businessLine: 'fabric', quantity: 10_000, quoteAmount: 1000, currency: 'USD', dueDate: '2099-01-01', status,
      customerRelationId: relationId, ownerId: requesterId, paymentInstrument: 'T/T', updatedAt: BigInt(Date.now()),
      moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
        snapshotAt: new Date().toISOString(), configId: null, source: 'fallback_constant' } } });
    await tx.orderStatusTransition.create({ data: { id: `${id}-original-transition`, orderId, fromStatus, toStatus: status,
      operator: requesterId, note: 'Synthetic existing guarded-state history', createdAt: BigInt(Date.now()) } });
    await tx.approvalRequest.create({ data: { id: exceptionApprovalId, requesterId, reviewerId, status: 'approved',
      actionType: 'order:dr013-exception', targetType: 'Dr013ExceptionRequest', targetId: exceptionId,
      risk: 'high', payload: { syntheticCommittedFactFixture: true }, decidedAt: new Date() } });
    await tx.dr013ExceptionRequest.create({ data: { id: exceptionId, exceptionNumber: exceptionId, exceptionCategory: 'credit_exemption',
      bypassedApprovalIds: [], exceptionReason: 'Synthetic committed fact to isolate scoped credit restoration atomicity.',
      riskMitigationPlan: 'No company approval or permanent recovery policy asserted', requesterId, reviewerId,
      approvalRequestId: exceptionApprovalId, status: 'ReviewerApproved', attachments: { files: [], scope } } });
    if (kind !== 'shipping') {
      await tx.approvalRequest.create({ data: { id: approvalId, requesterId, reviewerId, status: 'pending', risk: 'medium',
        actionType: kind === 'withdrawal' ? 'order:pause' : 'order:cancel', targetType: 'OrderChangeRequest', targetId: changeId,
        payload: { syntheticRequest: true, orderId, changeId } } });
      await tx.orderChangeRequest.create({ data: { id: changeId, orderId, requestNumber: changeId, status: 'Pending',
        beforeSnapshot: { status: fromStatus }, afterDelta: {}, changeTypes: ['other'],
        changeReason: 'Synthetic request fixture preserving the prior restoration decision contract.',
        requesterId, reviewerId, approvalRequestId: approvalId,
        attachments: kind === 'withdrawal' ? { pause: { expectedResumeDate: '2099-01-01' } } : {} } });
    } else await tx.shipment.create({ data: { id: shipmentId, shipmentNumber: shipmentId, type: 'Export', status: 'Booked',
      shippingMethod: 'Sea', orderId, customerRelationId: relationId, customerName: id,
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  });
  if (kind === 'shipping') ownShipments.add(shipmentId);
  return { id, kind, orderId, relationId, creditId, exceptionId, exceptionApprovalId, changeId, approvalId, shipmentId, status };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function changeService(client: PrismaClient) {
  return createOrderChangeRequestService({ prisma: client, approvalCreateService: createApprovalCreateService({
    prisma: client, routingService: createApprovalRoutingService({ prisma: client }),
  }) });
}
function http(client: PrismaClient) {
  const app = express(), onDataChange = vi.fn(); app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  const service = changeService(client);
  app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true, onDecided: async approval => {
    if (approval.targetType !== 'OrderChangeRequest') return;
    const result = await service.syncFromApprovalDecision({ approvalRequestId: approval.id, decision: approval.status,
      decisionNote: approval.decisionNote, actorId: approval.actualDecisionActor });
    if (!result.ok) throw Error(result.error.message); // exact production index callback contract
  } }));
  app.use('/api/v1/order-changes', createOrderChangeRouter({ prisma: client, requireAuth: true }));
  app.use('/api/v1/shipping', createShippingRouter({ prisma: client, requireAuth: true, apiKeys: new Set(), onDataChange }));
  return { app, onDataChange };
}
async function act(item: Fixture, app: ReturnType<typeof http>['app']) {
  if (item.kind === 'rejection') return request(app).post(`/api/v1/approvals/${item.approvalId}/decide`)
    .set('Authorization', `Bearer ${reviewerToken}`).send({ status: 'rejected', decisionNote: 'Synthetic isolated reviewer rejection' });
  if (item.kind === 'withdrawal') return request(app).post(`/api/v1/order-changes/${item.changeId}/withdraw`)
    .set('Authorization', `Bearer ${requesterToken}`).send({});
  return request(app).patch(`/api/v1/shipping/${item.shipmentId}`)
    .set('Authorization', `Bearer ${requesterToken}`).send({ status: 'Cancelled' });
}
async function snapshot(item: Fixture) {
  return { order: await db().order.findUniqueOrThrow({ where: { id: item.orderId } }),
    change: await db().orderChangeRequest.findUnique({ where: { id: item.changeId } }),
    shipment: await db().shipment.findUnique({ where: { id: item.shipmentId } }),
    credit: await db().creditLimit.findUniqueOrThrow({ where: { id: item.creditId } }),
    exception: await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.exceptionId } }),
    exceptionApproval: await db().approvalRequest.findUniqueOrThrow({ where: { id: item.exceptionApprovalId } }),
    transitions: await db().orderStatusTransition.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    shipmentEvents: await db().shipmentEvent.findMany({ where: { shipmentId: item.shipmentId }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { ownerType: 'shipment', ownerId: item.shipmentId }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { fromType: 'shipment', fromId: item.shipmentId }, orderBy: { id: 'asc' } }),
    // Only business projection/audit rows; committed decision and delivery logs
    // are asserted independently, not erased to fake an all-or-nothing decision.
    audits: await db().auditLog.findMany({ where: { OR: [
      { targetType: 'OrderChangeRequest', targetId: item.changeId }, { targetType: 'Shipment', targetId: item.shipmentId },
      { targetType: 'Order', targetId: item.orderId }, { targetType: 'Dr013ExceptionRequest', targetId: item.exceptionId },
    ] }, orderBy: { id: 'asc' } }),
  };
}
async function approvalHistory(item: Fixture) {
  return { row: await db().approvalRequest.findUniqueOrThrow({ where: { id: item.approvalId } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'ApprovalRequest', targetId: item.approvalId }, orderBy: { createdAt: 'asc' } }),
    notifications: await db().notification.findMany({ where: { userId: requesterId,
      metadata: { path: ['approvalId'], equals: item.approvalId } }, orderBy: { id: 'asc' } }) };
}
function scope(row: any) { return row.attachments.scope; }
async function mutateScope(item: Fixture, patch: Record<string, unknown>, status?: string) {
  const row = await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.exceptionId } });
  const attachments = row.attachments as any;
  await db().dr013ExceptionRequest.update({ where: { id: row.id }, data: {
    ...(status ? { status } : {}), attachments: { ...attachments, scope: { ...attachments.scope, ...patch } },
  } });
}
type Probe = { failAudit?: boolean; reached?: boolean; activeCaptured?: boolean; beforeProjection?: () => Promise<void>; activeBarrier?: () => Promise<void> };
function intercepted(item: Fixture, probe: Probe): PrismaClient {
  const client = db(); let mutationDone = false;
  const wrapExceptions = (model: any) => new Proxy(model, { get(delegate, method) {
    if (method === 'findMany') return async (...args: any[]) => {
      const rows = await delegate.findMany(...args);
      if (rows.some((row: any) => row.id === item.exceptionId && row.status === 'ReviewerApproved')) {
        probe.activeCaptured = true;
        if (probe.activeBarrier) await probe.activeBarrier();
        // Shipping's actual preflight is INSIDE its caller tx. Change the real
        // exception from a separate connection after that real read, before its
        // subsequent locked re-read. No business result is mocked.
        if (item.kind === 'shipping' && probe.beforeProjection && !mutationDone) {
          mutationDone = true; await probe.beforeProjection();
        }
      }
      return rows;
    };
    const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
  } });
  return new Proxy(client, { get(target, property) {
    if (property === 'dr013ExceptionRequest') return wrapExceptions(target.dr013ExceptionRequest);
    if (property === '$transaction') return async (work: any, options?: any) => {
      if (typeof work !== 'function') return (target.$transaction as any)(work, options);
      return target.$transaction(async tx => work(new Proxy(tx, { get(transaction, key) {
        if (key === 'dr013ExceptionRequest') return wrapExceptions(transaction.dr013ExceptionRequest);
        if (key === 'orderChangeRequest' && probe.beforeProjection) return new Proxy(transaction.orderChangeRequest, { get(delegate, method) {
          if (method === 'update') return async (...args: any[]) => {
            if (args[0].where.id === item.changeId && !mutationDone) { mutationDone = true; await probe.beforeProjection!(); }
            return (delegate.update as any)(...args);
          };
          const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        if (key === 'auditLog' && probe.failAudit) return new Proxy(transaction.auditLog, { get(delegate, method) {
          if (method === 'create') return async (args: any) => {
            if (args.data.action !== 'dr013_exception_consumed' || args.data.targetId !== item.exceptionId) return delegate.create(args);
            probe.reached = true;
            return delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-NONEXISTENT-audit-actor` } }); // REAL PG FK failure
          };
          const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(transaction, key); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), { ...options, timeout: 20_000 });
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function assertConsumed(item: Fixture, actorId: string) {
  const after = await snapshot(item);
  expect(after.order.status).toBe('Confirmed'); expect(after.credit.status).toBe('Frozen');
  expect(after.exception.status).toBe('Consumed'); expect(scope(after.exception)).toMatchObject({
    targetType: 'Order', targetId: item.orderId, action: 'order:confirm', maxUses: 1, usedCount: 1,
    consumptions: [{ consumedBy: actorId, consumedAt: expect.any(String) }],
  });
  const consumption = after.audits.filter(row => row.action === 'dr013_exception_consumed');
  expect(consumption).toHaveLength(1);
  expect(consumption[0]).toMatchObject({ actorId, targetType: 'Dr013ExceptionRequest', targetId: item.exceptionId,
    detail: { targetType: 'Order', targetId: item.orderId, action: 'order:confirm', usedCount: 1 } });
  expect(after.transitions.filter(row => row.toStatus === 'Confirmed')).toHaveLength(1);
  if (item.kind === 'shipping') { expect(after.shipment?.status).toBe('Cancelled'); expect(after.shipmentEvents).toHaveLength(1); }
  else expect(after.change?.status).toBe(item.kind === 'rejection' ? 'Rejected' : 'Cancelled');
  return after;
}
async function assertProjectionRefused(item: Fixture, response: any, probe: Probe, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(probe.activeCaptured, 'real active scoped pass was actually read').toBe(true);
  if (item.kind === 'rejection') {
    expect(response.status).toBe(200); expect(response.body.item.status).toBe('rejected');
    expect(response.body.sync).toEqual({ status: 'failed', retryable: true, code: 'APPROVAL_SYNC_FAILED' });
    const history = await approvalHistory(item);
    expect(history.row.status).toBe('rejected'); expect(history.row.decidedAt).toBeInstanceOf(Date);
    expect(history.audits.filter(row => row.action === 'reject_business_request')).toHaveLength(1);
    expect(history.audits.filter(row => row.action === 'approval_sync_failed')).toHaveLength(1);
    expect(history.audits.filter(row => row.action === 'approval_sync_completed')).toHaveLength(0);
    expect(history.notifications).toHaveLength(1); expect(history.notifications[0].type).toBe('approval_decided');
  } else {
    expect(response.status).toBe(probe.failAudit ? 500 : 409);
    const code = item.kind === 'shipping' ? response.body.error?.code : response.body.error;
    expect(code).toBe(probe.failAudit ? 'EXCEPTION_CONSUME_FAILED' : 'EXCEPTION_EXPIRED');
    if (item.kind === 'withdrawal') expect((await approvalHistory(item)).row.status).toBe('pending');
  }
  expect(await snapshot(item), 'all current business rows/audits/timeline/links roll back').toEqual(before);
}
function barrier() {
  let arrived = 0, timer: ReturnType<typeof setTimeout> | undefined, resolve!: () => void, reject!: (e: Error) => void;
  const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return async () => {
    arrived += 1;
    if (arrived === 1) timer = setTimeout(() => reject(Error('Both real active reads must reach the barrier')), 10_000);
    if (arrived === 2) { clearTimeout(timer); resolve(); }
    await ready;
  };
}

describe.sequential('RESTORE-CREDIT: independent PG business projection, exact scope and retry', () => {
  it('all finite consumption HTTP codes derive from the current shared registry', () => {
    for (const code of CREDIT_EXCEPTION_CONSUMPTION_CODES) expect(CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS[code]).toBe(httpStatusOfCode(code));
  });
  for (const kind of ['rejection', 'withdrawal', 'shipping'] as const) {
    it(`${kind}: legitimate restore Confirmed atomically consumes the exact order pass and actual actor once`, async () => {
      const item = await fixture(`${kind}-positive`, kind), route = http(db());
      const response = await act(item, route.app); expect(response.status).toBe(200);
      await assertConsumed(item, kind === 'rejection' ? reviewerId : requesterId);
      if (kind === 'rejection') {
        expect(response.body.sync).toEqual({ status: 'completed', retryable: false });
        expect((await approvalHistory(item)).notifications).toHaveLength(1);
      } else if (kind === 'withdrawal') expect((await approvalHistory(item)).row.status).toBe('cancelled');
      else {
        expect(route.onDataChange).toHaveBeenCalledTimes(1);
        expect(observed.filter(event => event.sourceEntityId === item.shipmentId)).toMatchObject([
          { type: 'ShipmentStatusChanged', actorId: requesterId, payload: { fromStatus: 'Booked', toStatus: 'Cancelled' } },
        ]);
      }
    });
    it(`${kind}: real mandatory-audit FK failure rolls back projection, then the real retry path completes`, async () => {
      const item = await fixture(`${kind}-sql-audit-fault`, kind), before = await snapshot(item), probe: Probe = { failAudit: true };
      const route = http(intercepted(item, probe)), response = await act(item, route.app);
      expect(probe.reached, 'fault must reach the actual mandatory audit SQL call').toBe(true);
      await assertProjectionRefused(item, response, probe, before);
      if (kind === 'shipping') {
        expect(route.onDataChange).not.toHaveBeenCalled();
        expect(observed.filter(event => event.sourceEntityId === item.shipmentId)).toHaveLength(0);
      }
      const healthy = http(db());
      if (kind === 'rejection') {
        const committed = await approvalHistory(item);
        const retry = await request(healthy.app).post(`/api/v1/approvals/${item.approvalId}/retry-sync`)
          .set('Authorization', `Bearer ${reviewerToken}`).send({});
        expect(retry.status).toBe(200); expect(retry.body.sync).toEqual({ status: 'completed', retryable: false });
        const after = await approvalHistory(item);
        expect(after.row).toEqual(committed.row); expect(after.notifications).toEqual(committed.notifications);
        expect(after.audits.filter(row => row.action === 'reject_business_request')).toHaveLength(1);
        expect(after.audits.filter(row => row.action === 'approval_sync_failed')).toEqual(committed.audits.filter(row => row.action === 'approval_sync_failed'));
        expect(after.audits.filter(row => row.action === 'approval_sync_completed')).toHaveLength(1);
        const replay = await request(healthy.app).post(`/api/v1/approvals/${item.approvalId}/retry-sync`)
          .set('Authorization', `Bearer ${reviewerToken}`).send({});
        expect(replay.status).toBe(200); expect(await approvalHistory(item)).toEqual(after);
      } else expect((await act(item, healthy.app)).status).toBe(200);
      await assertConsumed(item, kind === 'rejection' ? reviewerId : requesterId);
    });
    it(`${kind}: real deadline change after preflight cannot be used to restore Confirmed`, async () => {
      const item = await fixture(`${kind}-deadline`, kind), before = await snapshot(item);
      const probe: Probe = { beforeProjection: () => mutateScope(item, { validUntil: new Date(Date.now() - 1000).toISOString() }) };
      const route = http(intercepted(item, probe)), response = await act(item, route.app);
      const expected = { ...before, exception: await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.exceptionId } }) };
      expect(expected.exception).toMatchObject({ status: before.exception.status, approvalRequestId: before.exception.approvalRequestId,
        attachments: { scope: { targetType: 'Order', targetId: item.orderId, action: 'order:confirm', maxUses: 1, usedCount: 0, consumptions: [] } } });
      expect(expected.order.status).toBe(item.status);
      expect(expected.change?.status ?? null).toBe(kind === 'shipping' ? null : 'Pending');
      expect(expected.shipment?.status ?? null).toBe(kind === 'shipping' ? 'Booked' : null);
      expect(scope(expected.exception).usedCount).toBe(0);
      expect(expected.audits).toHaveLength(0); expect(expected.transitions).toHaveLength(1);
      expect(expected.shipmentEvents).toHaveLength(0); expect(expected.links).toHaveLength(0); expect(expected.references).toHaveLength(0);
      // The separately committed deadline mutation is intentionally retained;
      // it is not part of the failed business projection transaction.
      await assertProjectionRefused(item, response, probe, expected);
      expect(new Date(scope(expected.exception).validUntil).getTime()).toBeLessThan(Date.now());
      expect(route.onDataChange).not.toHaveBeenCalled();
    });
  }
  it('two actual Pending withdrawals after active reads compete for one real Order quota; only one projection commits', async () => {
    const first = await fixture('concurrent-use1', 'withdrawal'), second = { ...first, changeId: `${first.id}-second-change`, approvalId: `${first.id}-second-approval` };
    const original = await db().orderChangeRequest.findUniqueOrThrow({ where: { id: first.changeId } });
    await db().approvalRequest.create({ data: { id: second.approvalId, requesterId, reviewerId, status: 'pending', risk: 'medium',
      actionType: 'order:pause', targetType: 'OrderChangeRequest', targetId: second.changeId, payload: { syntheticRequest: true } } });
    await db().orderChangeRequest.create({ data: { id: second.changeId, orderId: first.orderId, requestNumber: second.changeId,
      beforeSnapshot: original.beforeSnapshot as any, afterDelta: {}, changeTypes: ['other'], changeReason: original.changeReason,
      requesterId, reviewerId, approvalRequestId: second.approvalId, status: 'Pending', attachments: original.attachments as any } });
    const wait = barrier(), firstProbe: Probe = { activeBarrier: wait }, secondProbe: Probe = { activeBarrier: wait };
    const responses = await Promise.all([act(first, http(intercepted(first, firstProbe)).app), act(second, http(intercepted(second, secondProbe)).app)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(responses.find(response => response.status === 409)?.body.error).toBe('EXCEPTION_ALREADY_CONSUMED');
    expect(firstProbe.activeCaptured && secondProbe.activeCaptured).toBe(true);
    const requests = await db().orderChangeRequest.findMany({ where: { id: { in: [first.changeId, second.changeId] } } });
    expect(requests.map(row => row.status).sort()).toEqual(['Cancelled', 'Pending']);
    const approvals = await db().approvalRequest.findMany({ where: { id: { in: [first.approvalId, second.approvalId] } } });
    expect(approvals.map(row => row.status).sort()).toEqual(['cancelled', 'pending']);
    const final = await snapshot(first);
    expect(scope(final.exception).usedCount).toBe(1); expect(scope(final.exception).consumptions).toHaveLength(1);
    expect(final.audits.filter(row => row.action === 'dr013_exception_consumed')).toHaveLength(1);
    expect(final.transitions.filter(row => row.toStatus === 'Confirmed')).toHaveLength(1); expect(final.order.status).toBe('Confirmed');
  });
  it('wrong target/action pass does not block withdrawal itself or silently restore the frozen order', async () => {
    const item = await fixture('wrong-scope-preflight', 'withdrawal');
    // A Pending exact-scope candidate keeps the real automatic routing path out
    // of this probe without manufacturing a reviewer/company policy.
    const row = await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.exceptionId } });
    await mutateScope(item, { targetType: 'Relation', targetId: item.relationId, action: 'order:create' });
    await db().approvalRequest.create({ data: { id: `${item.id}-pending-exact-approval`, requesterId, reviewerId, status: 'pending',
      risk: 'high', actionType: 'order:dr013-exception', targetType: 'Dr013ExceptionRequest', targetId: `${item.id}-pending-exact`, payload: { syntheticRequest: true } } });
    await db().dr013ExceptionRequest.create({ data: { id: `${item.id}-pending-exact`, exceptionNumber: `${item.id}-pending-exact`,
      requesterId, reviewerId, status: 'Pending', exceptionCategory: 'credit_exemption', bypassedApprovalIds: [],
      exceptionReason: 'Synthetic existing pending request with no approval decision to preserve a denied preflight.',
      approvalRequestId: `${item.id}-pending-exact-approval`, attachments: row.attachments as any } });
    const response = await act(item, http(db()).app); expect(response.status).toBe(200);
    expect(response.body.orderRestoredTo).toBeNull(); expect(response.body.restoreBlocked.code).toBe('CREDIT_FROZEN_60_DAYS');
    const after = await snapshot(item); expect(after.order.status).toBe('PauseRequested'); expect(after.change?.status).toBe('Cancelled');
    expect(scope(after.exception).usedCount).toBe(0); expect(after.exception.status).toBe('ReviewerApproved');
    expect(after.transitions).toHaveLength(1); expect(after.audits.some(row => row.action === 'dr013_exception_consumed')).toBe(false);
    expect(after.credit.status).toBe('Frozen');
  });
  it('restoring Production preserves the accepted forward-side contract and leaves an unused Confirmed pass intact', async () => {
    const item = await fixture('production-contract', 'withdrawal', 'Production'), before = await snapshot(item);
    const response = await act(item, http(db()).app); expect(response.status).toBe(200); expect(response.body.orderRestoredTo).toBe('Production');
    const after = await snapshot(item); expect(after.order.status).toBe('Production'); expect(after.credit).toEqual(before.credit);
    expect(after.exception).toEqual(before.exception); expect(after.exceptionApproval).toEqual(before.exceptionApproval);
    expect(after.audits.some(row => row.action === 'dr013_exception_consumed')).toBe(false);
  });
});
