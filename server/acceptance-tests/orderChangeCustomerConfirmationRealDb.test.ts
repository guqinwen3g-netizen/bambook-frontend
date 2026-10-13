/**
 * Native OrderChange -> assigned approval HTTP -> screenshot customer confirmation
 * HTTP -> native Order/OrderLine apply over the reviewed isolated PostgreSQL runner.
 * All business records are synthetic fixtures created in the runner's empty PG.
 * No index bootstrap, scheduler, shared/business database, external delivery or
 * customer login is involved. This proves the server-side business chain, not a
 * browser/role-UI workflow or company permission policy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRouter, type ApprovalRouterOptions } from '../src/approvals/approvalRoute';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { createOrderChangeCustomerConfirmationAdapter } from '../src/orderChanges/orderChangeCustomerConfirmationAdapter';
import { createOrderChangeRequestService } from '../src/orderChanges/orderChangeRequestService';
import { createOrderChangeRouter } from '../src/orderChanges/orderChangeRoute';
import { createCustomerConfirmationRouter } from '../src/customerConfirmations/customerConfirmationRoute';
import { createCustomerConfirmationTargetRegistry } from '../src/customerConfirmations/customerConfirmationService';
import { serializeValue } from '../src/lib/serializeValue';

const prefix = `acceptance-order-change-customer-${randomUUID()}`;
const auth = createAuthService();
const screenshot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l60AAAAASUVORK5CYII=',
  'base64',
);
const screenshotSha256 = createHash('sha256').update(screenshot).digest('hex');
const createScope = 'order:change_request:create';
const applyScope = 'order:change_request:apply';
const readScope = 'orders:read';
let prisma: PrismaClient | undefined;
let fixtureSequence = 0;

type ActorFixture = { id: string; roleId: 'sales' | 'manager'; actor: TokenPayload; bearer: string };
type Fixture = {
  id: string; departmentId: string; sales: ActorFixture; manager: ActorFixture; outsider: ActorFixture;
  relationId: string; orderId: string; lineId: string; applyGrantId: string;
};
type AppHarness = { app: Express };

function db(): PrismaClient {
  if (!prisma) throw new Error('Order-change acceptance requires the verified isolated PostgreSQL client');
  return prisma;
}

function bearer(actor: TokenPayload): string {
  return `Bearer ${auth.signToken(actor)}`;
}

function makeApp(routeClient: PrismaClient = db()): AppHarness {
  const approvalCreateService = createApprovalCreateService({ prisma: routeClient,
    routingService: createApprovalRoutingService({ prisma: routeClient }) });
  const orderChangeService = createOrderChangeRequestService({ prisma: routeClient, approvalCreateService });
  const targets = createCustomerConfirmationTargetRegistry([
    createOrderChangeCustomerConfirmationAdapter({ prisma: routeClient, service: orderChangeService }),
  ]);
  const onDecided: NonNullable<ApprovalRouterOptions['onDecided']> = async approval => {
    if (approval.targetType !== 'OrderChangeRequest') return;
    const synced = await orderChangeService.syncFromApprovalDecision({ approvalRequestId: approval.id,
      decision: approval.status, decisionNote: approval.decisionNote, actorId: approval.actualDecisionActor });
    if (!synced.ok) throw new Error(synced.error.message);
  };
  const app = express();
  app.set('json replacer', (_key: string, value: unknown) => serializeValue(value));
  app.use(express.json());
  app.use('/api/v1/order-changes', createOrderChangeRouter({ prisma: routeClient, requireAuth: true }));
  app.use('/api/v1/customer-confirmations', createCustomerConfirmationRouter({ prisma: routeClient, targetAdapters: targets }));
  app.use('/api/v1/approvals', createApprovalRouter({ prisma: routeClient, requireAuth: true, onDecided }));
  return { app };
}

async function makeActor(id: string, departmentId: string, roleId: 'sales' | 'manager', scopes: string[], grantorId: string): Promise<ActorFixture> {
  await db().userAccount.create({ data: { id, displayName: `Synthetic ${roleId} ${id}`, status: 'active', primaryDeptId: departmentId } });
  await db().userRole.create({ data: { id: `${id}-role`, userId: id, roleId, departmentId } });
  const grants = scopes.map(scope => ({ id: `${id}-grant-${scope}`, userId: id, scope,
    grantedBy: grantorId, isActive: true, reason: 'Synthetic isolated acceptance permission' }));
  if (grants.length) await db().userPermissionOverrides.createMany({ data: grants });
  const loaded = await loadUserWithRoles(db(), id);
  expect(loaded?.status).toBe('active');
  const actor = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(actor.authorizationLoaded).toBe(true);
  return { id, roleId, actor, bearer: bearer(actor) };
}

async function fixture(label: string): Promise<Fixture> {
  const id = `${prefix}-${++fixtureSequence}-${label}`;
  const departmentId = `${id}-department`, relationId = `${id}-customer`, orderId = `${id}-order`, lineId = `${id}-line`;
  await db().department.create({ data: { id: departmentId, name: 'Synthetic order-change acceptance department', status: 'active' } });
  await db().role.upsert({ where: { id: 'sales' }, update: {}, create: { id: 'sales', name: 'Synthetic sales role', isSystem: true } });
  await db().role.upsert({ where: { id: 'manager' }, update: {}, create: { id: 'manager', name: 'Synthetic manager role', isSystem: true } });
  const grantorId = `${id}-grantor`;
  await db().userAccount.create({ data: { id: grantorId, displayName: 'Synthetic acceptance grantor', status: 'active', primaryDeptId: departmentId } });
  const manager = await makeActor(`${id}-manager`, departmentId, 'manager', [readScope, applyScope], grantorId);
  const sales = await makeActor(`${id}-sales`, departmentId, 'sales', [readScope, applyScope, createScope], grantorId);
  // Same endpoint scopes as the salesperson, but intentionally absent from
  // this customer's owner/follow-up anchors and any team data grant.
  const outsider = await makeActor(`${id}-outsider`, departmentId, 'sales', [readScope, applyScope, createScope], grantorId);
  await db().department.update({ where: { id: departmentId }, data: { headId: manager.id } });
  await db().relation.create({ data: { id: relationId, name: `${id} synthetic customer`, category: 'Customer', type: 'Company',
    isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()),
    ownerId: sales.id, departmentId, salesRepIds: [sales.id, manager.id] } });
  const now = BigInt(Date.now());
  await db().order.create({ data: { id: orderId, poNumber: `${id}-po`, customer: `${id} synthetic customer`,
    product: 'Synthetic customer-confirmed order', type: 'Garment', businessLine: 'garment', quantity: 10, unit: 'pcs',
    status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: 200, contractAmount: 200, totalNet: 200,
    currency: 'CNY', customerRelationId: relationId, ownerId: sales.id, departmentId, updatedAt: now } });
  await db().orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', description: 'Synthetic order line',
    quantity: '10.0000', unit: 'pcs', unitPrice: '20.0000', netValue: '200.0000', status: 'Confirmed' } });
  const applyGrantId = `${sales.id}-grant-${applyScope}`;
  return { id, departmentId, sales, manager, outsider, relationId, orderId, lineId, applyGrantId };
}

async function createPendingChange(app: Express, item: Fixture) {
  const response = await request(app).post('/api/v1/order-changes').set('Authorization', item.sales.bearer).send({
    orderId: item.orderId,
    changeType: 'price',
    beforeSnapshot: { unitPrice: '200.0000' },
    afterDelta: { unitPrice: '220.00' },
    changeReason: '客户已确认的订单价格因面料成本变化需要调整',
    impactSummary: '订单金额及后续回款计划随新价格重算',
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.changeRequest.status).toBe('Pending');
  expect(response.body.changeRequest.requesterId).toBe(item.sales.id);
  expect(response.body.approvalRequestId).toBeTruthy();
  return { changeRequestId: response.body.changeRequest.id as string, approvalId: response.body.approvalRequestId as string };
}

async function approveChange(app: Express, item: Fixture, approvalId: string) {
  const loaded = await request(app).get(`/api/v1/approvals/${encodeURIComponent(approvalId)}`)
    .set('Authorization', item.manager.bearer);
  expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
  expect(loaded.body.item.reviewerId).toBe(item.manager.id);
  const decision = await request(app).post(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decide`)
    .set('Authorization', item.manager.bearer).send({ status: 'approved',
      reviewContentVersion: loaded.body.item.reviewContentVersion, confirmedReviewedContent: true,
      decisionNote: '已核对本次最终价格和订单来源' });
  expect(decision.status, JSON.stringify(decision.body)).toBe(200);
  expect(decision.body.item.status).toBe('approved');
  const native = await db().orderChangeRequest.findFirstOrThrow({ where: { approvalRequestId: approvalId } });
  expect(native.status).toBe('Approved');
}

async function customerTarget(app: Express, item: Fixture, changeRequestId: string) {
  const response = await request(app).get(`/api/v1/customer-confirmations/by-target/OrderChangeRequest/${encodeURIComponent(changeRequestId)}`)
    .set('Authorization', item.sales.bearer);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.target.eligible).toBe(true);
  expect(response.body.target.internalApprovalId).toBeTruthy();
  return response.body.target;
}

function customerCommand(target: any, targetId: string, idempotencyKey = randomUUID()) {
  return {
    targetType: 'OrderChangeRequest', targetId,
    finalContentFingerprint: target.finalContentFingerprint,
    internalApprovalId: target.internalApprovalId,
    scopeFingerprint: target.scopeFingerprint,
    scope: target.scope,
    outcome: 'accepted', customerName: 'Synthetic customer contact',
    customerAddress: 'acceptance@example.invalid', confirmedAt: new Date().toISOString(),
    channel: 'screenshot', idempotencyKey,
  };
}

function postScreenshot(app: Express, actorBearer: string, command: ReturnType<typeof customerCommand>) {
  return request(app).post('/api/v1/customer-confirmations').set('Authorization', actorBearer)
    .field('command', JSON.stringify(command)).field('source', JSON.stringify({ kind: 'screenshot' }))
    .attach('file', screenshot, { filename: 'synthetic-customer-confirmation.png', contentType: 'image/png' });
}

async function nativeSnapshot(item: Fixture, requesterId: string, managerId: string) {
  const [order, lines, changes, approvals, transitions, managerAudits] = await Promise.all([
    db().order.findUniqueOrThrow({ where: { id: item.orderId } }),
    db().orderLine.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    db().orderChangeRequest.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    db().approvalRequest.findMany({ where: { requesterId, targetType: 'OrderChangeRequest', targetId: item.orderId }, orderBy: { id: 'asc' } }),
    db().orderStatusTransition.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    db().auditLog.findMany({ where: { actorId: managerId }, orderBy: { id: 'asc' } }),
  ]);
  return { order, lines, changes, approvals, transitions, managerAudits };
}

function revokingGrantClient(userId: string, scope: string) {
  let armed = false;
  let revoked = false;
  const client = new Proxy(db(), { get(target, key) {
    if (key === '$transaction') {
      const transaction = (target.$transaction as any).bind(target);
      return async (work: any, options?: any) => {
        if (typeof work !== 'function') return transaction(work, options);
        let savedConfirmation = false;
        const result = await transaction((tx: any) => work(new Proxy(tx, { get(inner, delegate) {
          if (delegate === 'businessConfirmation' && armed) {
            return new Proxy(inner.businessConfirmation, { get(model, method) {
              if (method === 'create') return async (args: any) => {
                const created = await model.create(args);
                savedConfirmation = armed;
                return created;
              };
              const value = Reflect.get(model, method);
              return typeof value === 'function' ? value.bind(model) : value;
            } });
          }
          const value = Reflect.get(inner, delegate);
          return typeof value === 'function' ? value.bind(inner) : value;
        } })), options);
        if (armed && savedConfirmation) {
          armed = false;
          await db().userPermissionOverrides.update({ where: { userId_scope: { userId, scope } }, data: { isActive: false } });
          revoked = true;
        }
        return result;
      };
    }
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client: client as PrismaClient, arm: () => { armed = true; }, wasRevoked: () => revoked };
}

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port)
    throw new Error('Reviewed isolated PostgreSQL runner is required; refusing an ordinary database');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect([url.pathname, url.port]).toEqual([`/${name}`, port]);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'verify physical isolated PG identity before the first fixture write').toEqual([
    { name, directory, port: Number(port) },
  ]);
  for (const roleId of ['sales', 'manager'] as const) {
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: `Synthetic ${roleId} role`, isSystem: true } });
    expect(await db().rolePermission.count({ where: { roleId } }), 'synthetic fixture must not infer role grants').toBe(0);
  }
});

afterAll(async () => { await prisma?.$disconnect(); });

describe.sequential('actual isolated PG order-change customer-confirmation HTTP chain', () => {
  it('internal approval then screenshot confirmation applies and reads back native Order and OrderLine facts', async () => {
    const item = await fixture('full-chain');
    const { app } = makeApp();
    const initialOrder = await db().order.findUniqueOrThrow({ where: { id: item.orderId } });
    const initialLine = await db().orderLine.findUniqueOrThrow({ where: { id: item.lineId } });
    const pending = await createPendingChange(app, item);
    await approveChange(app, item, pending.approvalId);
    expect(await db().order.findUniqueOrThrow({ where: { id: item.orderId } })).toEqual(initialOrder);
    expect(await db().orderLine.findUniqueOrThrow({ where: { id: item.lineId } })).toEqual(initialLine);

    const target = await customerTarget(app, item, pending.changeRequestId);
    const saved = await postScreenshot(app, item.sales.bearer, customerCommand(target, pending.changeRequestId));
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.saved).toBe(true);
    expect(saved.body.continuationStatus).toBe('completed');
    expect(saved.body.effect.status).toBe('applied');
    expect(saved.body.nativeStatus.changeRequestStatus).toBe('Applied');

    const [order, line, change, confirmations, links, screenshotFile, applyAudits] = await Promise.all([
      db().order.findUniqueOrThrow({ where: { id: item.orderId } }),
      db().orderLine.findUniqueOrThrow({ where: { id: item.lineId } }),
      db().orderChangeRequest.findUniqueOrThrow({ where: { id: pending.changeRequestId } }),
      db().businessConfirmation.findMany({ where: { targetType: 'OrderChangeRequest', targetId: pending.changeRequestId } }),
      db().businessConfirmationEvidence.findMany({ where: { confirmation: { targetType: 'OrderChangeRequest', targetId: pending.changeRequestId } }, include: { evidence: true } }),
      db().customerEvidenceFile.findUnique({ where: { sha256: screenshotSha256 } }),
      db().auditLog.findMany({ where: { action: 'order_change_approved', targetType: 'Order', targetId: item.orderId,
        transactionId: pending.approvalId }, orderBy: { id: 'asc' } }),
    ]);
    expect(change).toMatchObject({ status: 'Applied', appliedBy: item.sales.id, approvalRequestId: pending.approvalId });
    expect(order.quoteAmount.toString()).toBe('220');
    expect(order.contractAmount?.toString()).toBe('220');
    expect(order.totalNet?.toString()).toBe('220');
    expect(line.quantity.toString()).toBe('10');
    expect(line.unitPrice?.toString()).toBe('22');
    expect(line.netValue?.toString()).toBe('220');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ outcome: 'accepted', channel: 'screenshot', recordedBy: item.sales.id,
      internalApprovalId: pending.approvalId, finalContentFingerprint: target.finalContentFingerprint });
    expect(links).toHaveLength(1);
    expect(links[0].evidence).toMatchObject({ sourceType: 'screenshot', sourceSnapshot: expect.objectContaining({ sha256: expect.any(String) }) });
    expect(links[0].evidence.sourceSnapshot.sha256).toBe(screenshotSha256);
    expect(screenshotFile).toMatchObject({ sha256: screenshotSha256, byteSize: screenshot.length });
    const screenshotLinks = await db().customerEvidenceFileLink.findMany({ where: { evidenceId: links[0].evidenceId }, include: { file: true } });
    expect(screenshotLinks).toHaveLength(1);
    expect(screenshotLinks[0]).toMatchObject({ purpose: 'screenshot', mimeType: 'image/png', file: { sha256: screenshotSha256 } });
    expect(applyAudits).toHaveLength(1);
    expect(applyAudits[0]).toMatchObject({ actorId: item.sales.id, fieldPath: 'unitPrice', afterValue: '220.00' });

    const readback = await request(app).get(`/api/v1/customer-confirmations/by-target/OrderChangeRequest/${encodeURIComponent(pending.changeRequestId)}`)
      .set('Authorization', item.sales.bearer);
    expect(readback.status, JSON.stringify(readback.body)).toBe(200);
    expect(readback.body.latest).toMatchObject({ id: confirmations[0].id, outcome: 'accepted', matchesCurrentVersion: true });
    expect(readback.body.target.nativeStatus).toMatchObject({ changeRequestStatus: 'Applied', effect: 'applied', applyAuditValid: true });
  }, 30_000);

  it('stale final-proposal signature returns 409 with no successor, decision, audit or business write', async () => {
    const item = await fixture('stale-amendment-signature');
    const { app } = makeApp();
    const pending = await createPendingChange(app, item);
    const approvalRead = await request(app).get(`/api/v1/approvals/${encodeURIComponent(pending.approvalId)}`)
      .set('Authorization', item.manager.bearer);
    expect(approvalRead.status, JSON.stringify(approvalRead.body)).toBe(200);
    const proposal = { afterDelta: { unitPrice: '230.00' }, changeReason: '领导核对后调整客户已确认的价格方案',
      impactSummary: '订单最终金额与逐行金额需要同步重算' };
    const preview = await request(app).post(`/api/v1/order-changes/${encodeURIComponent(pending.changeRequestId)}/amend-preview`)
      .set('Authorization', item.manager.bearer).send({ ...proposal,
        reviewContentVersion: approvalRead.body.item.reviewContentVersion });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.finalProposalFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // A controlled source drift models a separate legitimate native edit that
    // commits after review preview; it is part of the stale-signature premise.
    await db().orderLine.update({ where: { id: item.lineId }, data: { unitPrice: '21.0000', netValue: '210.0000' } });
    await db().order.update({ where: { id: item.orderId }, data: { quoteAmount: 210, contractAmount: 210,
      totalNet: 210, updatedAt: BigInt(Date.now() + 1_000) } });
    const before = await nativeSnapshot(item, item.sales.id, item.manager.id);
    const stale = await request(app).post(`/api/v1/order-changes/${encodeURIComponent(pending.changeRequestId)}/amend-and-approve`)
      .set('Authorization', item.manager.bearer).send({ ...proposal,
        reviewContentVersion: approvalRead.body.item.reviewContentVersion,
        expectedFinalProposalFingerprint: preview.body.finalProposalFingerprint,
        confirmedReviewedContent: true });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error).toBe('ORDER_CHANGE_VERSION_MISMATCH');
    expect(await nativeSnapshot(item, item.sales.id, item.manager.id), 'stale signed content may not write any application fact').toEqual(before);
  }, 30_000);

  it('saved confirmation remains pending after grant revocation; restored exact idempotent retry applies once', async () => {
    const item = await fixture('grant-revocation-recovery');
    const probe = revokingGrantClient(item.sales.id, applyScope);
    const { app } = makeApp(probe.client);
    const pending = await createPendingChange(app, item);
    await approveChange(app, item, pending.approvalId);
    const target = await customerTarget(app, item, pending.changeRequestId);
    const command = customerCommand(target, pending.changeRequestId);
    probe.arm();
    const first = await postScreenshot(app, item.sales.bearer, command);
    expect(probe.wasRevoked()).toBe(true);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.saved).toBe(true);
    expect(first.body.continuationStatus).toBe('pending');
    expect(first.body.effect.status).toBe('pending');
    expect(first.body.effect.code).toBe('FORBIDDEN');
    expect(first.body.nativeStatus.changeRequestStatus).toBe('Approved');
    expect(await db().userPermissionOverrides.findUniqueOrThrow({ where: { userId_scope: { userId: item.sales.id, scope: applyScope } } }))
      .toMatchObject({ isActive: false });
    expect(await db().businessConfirmation.count({ where: { targetType: 'OrderChangeRequest', targetId: pending.changeRequestId } })).toBe(1);
    expect((await db().orderChangeRequest.findUniqueOrThrow({ where: { id: pending.changeRequestId } })).status).toBe('Approved');
    expect((await db().order.findUniqueOrThrow({ where: { id: item.orderId } })).quoteAmount.toString()).toBe('200');
    expect((await db().orderLine.findUniqueOrThrow({ where: { id: item.lineId } })).netValue?.toString()).toBe('200');
    expect(await db().auditLog.count({ where: { action: 'order_change_approved', targetType: 'Order', targetId: item.orderId,
      transactionId: pending.approvalId } })).toBe(0);

    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.sales.id, scope: applyScope } }, data: { isActive: true } });
    const retry = await postScreenshot(app, item.sales.bearer, command);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.confirmation.id).toBe(first.body.confirmation.id);
    expect(retry.body.continuationStatus).toBe('completed');
    expect(retry.body.effect.status).toBe('applied');
    expect((await db().orderChangeRequest.findUniqueOrThrow({ where: { id: pending.changeRequestId } })).status).toBe('Applied');
    expect((await db().order.findUniqueOrThrow({ where: { id: item.orderId } })).quoteAmount.toString()).toBe('220');
    expect((await db().orderLine.findUniqueOrThrow({ where: { id: item.lineId } })).netValue?.toString()).toBe('220');
    expect(await db().businessConfirmation.count({ where: { targetType: 'OrderChangeRequest', targetId: pending.changeRequestId } })).toBe(1);
    expect(await db().businessConfirmationEvidence.count({ where: { confirmationId: first.body.confirmation.id } })).toBe(1);
    const savedLink = await db().businessConfirmationEvidence.findFirstOrThrow({ where: { confirmationId: first.body.confirmation.id } });
    expect(await db().customerEvidenceFileLink.count({ where: { evidenceId: savedLink.evidenceId } })).toBe(1);
    expect(await db().customerEvidenceFile.count({ where: { sha256: screenshotSha256 } })).toBe(1);
    expect(await db().auditLog.count({ where: { action: 'order_change_approved', targetType: 'Order', targetId: item.orderId,
      transactionId: pending.approvalId } })).toBe(1);
  }, 30_000);

  it('actor with the same operation grants but outside this order customer scope cannot confirm', async () => {
    const item = await fixture('scope-outside-actor');
    const { app } = makeApp();
    const pending = await createPendingChange(app, item);
    await approveChange(app, item, pending.approvalId);
    const target = await customerTarget(app, item, pending.changeRequestId);
    expect(item.outsider.actor.permissions).toEqual(item.sales.actor.permissions);
    expect(item.outsider.id).not.toBe(item.sales.id);
    const before = await nativeSnapshot(item, item.sales.id, item.manager.id);
    const denied = await postScreenshot(app, item.outsider.bearer, customerCommand(target, pending.changeRequestId));
    expect(denied.status).toBe(404); // The confirmation route conceals inaccessible business targets.
    expect(denied.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(await nativeSnapshot(item, item.sales.id, item.manager.id)).toEqual(before);
    expect(await db().businessConfirmation.count({ where: { targetType: 'OrderChangeRequest', targetId: pending.changeRequestId } })).toBe(0);
    expect(await db().businessConfirmationEvidence.count({ where: { confirmation: { targetType: 'OrderChangeRequest', targetId: pending.changeRequestId } } })).toBe(0);
  }, 30_000);
});
