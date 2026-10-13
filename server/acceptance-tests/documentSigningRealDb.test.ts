/** Canonical role HTTP signing plus native frozen-document readback, isolated PostgreSQL only. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';
import { createCustomsRouter } from '../src/customs/customsRoute';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { resolveDocumentSigner } from '../src/seal/documentSigner';
import { serializeValue } from '../src/lib/serializeValue';
import { createQuotationService } from '../src/quotations/quotationService';
import { createQuotationApprovalService } from '../src/quotations/quotationApproval';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';

const prefix = `acceptance-document-sign-${randomUUID()}`;
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
const seededUserIds: string[] = [], seededOrderIds: string[] = [];
const seededQuotationIds: string[] = [], seededCustomerIds: string[] = [];
function db(): PrismaClient { if (!prisma) throw Error('Reviewed isolated PostgreSQL required'); return prisma; }
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
type ActorFixture = { id: string; roleId: SystemRoleId; actor: TokenPayload; token: string };
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated PostgreSQL runner is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);

  // Populate the canonical built-in role grants from the same production seed
  // helper. No per-user overrides or test-only role-to-scope mapping is used.
  const roleIds = Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[];
  for (const roleId of roleIds) {
    await db().role.upsert({ where: { id: roleId }, update: {},
      create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
  }
  const scopes = [...new Set(roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId)))];
  await db().permission.createMany({ data: scopes.map(scope => ({ id: `${prefix}-permission-${scope}`, scope })), skipDuplicates: true });
  const permissions = await db().permission.findMany({ where: { scope: { in: scopes } }, select: { id: true, scope: true } });
  const permissionIds = new Map(permissions.map(permission => [permission.scope, permission.id]));
  await db().rolePermission.createMany({ data: roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId).map(scope => ({
    id: `${prefix}-role-grant-${roleId}-${scope}`, roleId, permissionId: permissionIds.get(scope)!,
  }))), skipDuplicates: true });
});
async function actor(roleId: SystemRoleId, label: string): Promise<ActorFixture> {
  const id = `${prefix}-${++sequence}-${label}`;
  await db().userAccount.create({ data: { id, displayName: `Synthetic ${roleId} ${id}`, status: 'active' } });
  seededUserIds.push(id);
  await db().userRole.create({ data: { id: `${id}-membership`, userId: id, roleId } });
  const loaded = await loadUserWithRoles(db(), id);
  if (!loaded) throw Error(`Synthetic canonical actor ${id} did not load`);
  const current = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(current.roleIds).toContain(roleId);
  expect(current.permissions).toEqual(expect.arrayContaining(getDatabaseSeedScopeListForRole(roleId)));
  expect(await db().userPermissionOverrides.count({ where: { userId: id } })).toBe(0);
  return { id, roleId, actor: current, token: auth.signToken(current) };
}

afterAll(async () => {
  if (!prisma) return;
  try {
    await db().auditLog.deleteMany({ where: { actorId: { in: seededUserIds } } });
    await db().notification.deleteMany({ where: { userId: { in: seededUserIds } } });
    await db().approvalRequest.deleteMany({ where: { requesterId: { in: seededUserIds } } });
    await db().quotationLine.deleteMany({ where: { quotationId: { in: seededQuotationIds } } });
    await db().quotationVersion.deleteMany({ where: { quotationId: { in: seededQuotationIds } } });
    await db().quotation.deleteMany({ where: { id: { in: seededQuotationIds } } });
    await db().relation.deleteMany({ where: { id: { in: seededCustomerIds } } });
    await db().orderLine.deleteMany({ where: { orderId: { in: seededOrderIds } } });
    await db().order.deleteMany({ where: { id: { in: seededOrderIds } } });
    await db().userRole.deleteMany({ where: { userId: { in: seededUserIds } } });
    await db().userAccount.deleteMany({ where: { id: { in: seededUserIds } } });
  } finally { await prisma.$disconnect(); }
});

function app() {
  const application = express();
  application.use(express.json()); application.set('json replacer', (_key: string, value: unknown) => serializeValue(value));
  application.use(createAccountStatusGuard(db()));
  application.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  application.use('/api/v2/orders', createOrdersV2Router({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  application.use('/api/v1/customs', createCustomsRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  application.use('/api/v1/approvals', createApprovalRouter({ prisma: db(), requireAuth: true }));
  return application;
}
async function pending() {
  const requester = await actor(SYSTEM_ROLE_IDS.SALES_MANAGER, 'requester');
  const leader = await actor(SYSTEM_ROLE_IDS.ADMIN, 'leader');
  const orderId = `${prefix}-order-${++sequence}`, lineId = `${orderId}-line`;
  seededOrderIds.push(orderId);
  await db().order.create({ data: { id: orderId, poNumber: `${orderId}-PO`, customer: 'Synthetic customer',
    product: 'Synthetic fabric', type: 'fabric', businessLine: 'fabric', quantity: '3', unit: 'M', status: 'Confirmed',
    dueDate: '2099-01-01', quoteAmount: '12', currency: 'USD', ownerId: requester.id, updatedAt: BigInt(Date.now()) } });
  await db().orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, description: 'Synthetic agreed fabric',
    quantity: '3', unit: 'M', unitPrice: '4', netValue: '12' } });
  const application = app();
  const sent = await request(application).post(`/api/v2/orders/${orderId}/request-sign`)
    .set('Authorization', `Bearer ${requester.token}`).send({});
  expect(sent.status, diagnostic(sent.body)).toBe(201);
  const approvalId = sent.body.approvalId as string;
  // Native fallback can select an earlier canonical admin in this test database.
  const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  const loaded = await loadUserWithRoles(db(), approval.reviewerId!);
  expect(loaded).toBeTruthy();
  const reviewerActor = await buildLoadedAuthTokenPayload(db(), loaded);
  const reviewerToken = auth.signToken(reviewerActor);
  const detail = await request(application).get(`/api/v1/approvals/${approvalId}/detail`)
    .set('Authorization', `Bearer ${reviewerToken}`);
  expect(detail.status, diagnostic(detail.body)).toBe(200);
  expect(detail.body.detail.canApprove, diagnostic(detail.body)).toBe(true);
  const signBody = { status: 'approved', confirmedReviewedContent: true,
    reviewContentVersion: detail.body.detail.reviewContentVersion, reviewPreviewDigest: detail.body.detail.frozen.previewDigest };
  return { requester, leader, orderId, lineId, approvalId, application, reviewerActor, reviewerToken, signBody };
}

describe.sequential('isolated canonical order-document signing', () => {
  it('signs only the current quotation approved through the real reviewed decision, and never reuses it after a price change', async () => {
    const requester = await actor(SYSTEM_ROLE_IDS.SALES_MANAGER, 'quotation-requester');
    await actor(SYSTEM_ROLE_IDS.ADMIN, 'quotation-reviewer');
    const customerId = `${prefix}-quotation-customer-${++sequence}`;
    seededCustomerIds.push(customerId);
    await db().relation.create({ data: { id: customerId, name: 'Synthetic reviewed quotation customer', category: 'customer',
      type: 'company', isOrganization: true, ownerId: requester.id, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
    const quotation = await createQuotationService(db()).createQuotation({ quotationNumber: `${prefix}-QT-${sequence}`,
      customerRelationId: customerId, customerName: 'Synthetic reviewed quotation customer', currency: 'USD',
      issueDate: '2026-10-05', lines: [{ description: 'Synthetic reviewed cotton', quantity: 10000, unit: 'M', unitPrice: 2.5001 }] }, requester.id);
    seededQuotationIds.push(quotation.id);
    const creator = createQuotationApprovalService({ prisma: db(), approvalCreateService: createApprovalCreateService({ prisma: db(),
      routingService: createApprovalRoutingService({ prisma: db() }) }) });
    const approval = (await creator.requestTotalApproval({ quotationId: quotation.id, actorId: requester.id })).totalApproval!;
    const reviewer = await loadUserWithRoles(db(), approval.reviewerId!);
    const token = auth.signToken(await buildLoadedAuthTokenPayload(db(), reviewer));
    const application = app();
    const detail = await request(application).get(`/api/v1/approvals/${approval.id}/detail`).set('Authorization', `Bearer ${token}`);
    expect(detail.status, diagnostic(detail.body)).toBe(200);
    const decision = await request(application).post(`/api/v1/approvals/${approval.id}/decide`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'approved', confirmedReviewedContent: true, reviewContentVersion: detail.body.detail.reviewContentVersion,
        reviewPreviewDigest: detail.body.detail.frozen.previewDigest });
    expect(decision.status, diagnostic(decision.body)).toBe(200);
    const signer = await resolveDocumentSigner(db(), { targetType: 'Quotation', targetId: quotation.id });
    expect(signer?.userId).toBe(approval.reviewerId);
    expect(signer?.quotationData?.qt.totalAmount).toBe(25001);
    await db().quotationLine.update({ where: { id: quotation.lines[0].id }, data: { unitPrice: '3', amount: '30000' } });
    await db().quotation.update({ where: { id: quotation.id }, data: { totalAmount: '30000' } });
    expect(await resolveDocumentSigner(db(), { targetType: 'Quotation', targetId: quotation.id })).toBeNull();
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('approved');
  });
  it('rejects a new signing request when the current write role was revoked despite the old JWT', async () => {
    const f = await pending();
    await db().userRole.deleteMany({ where: { userId: f.requester.id } });
    const before = await db().approvalRequest.count({ where: { targetType: 'OrderConfirmation', targetId: f.orderId } });
    const denied = await request(f.application).post(`/api/v2/orders/${f.orderId}/request-sign`)
      .set('Authorization', `Bearer ${f.requester.token}`).send({});
    expect(denied.status, diagnostic(denied.body)).toBe(403);
    expect(await db().approvalRequest.count({ where: { targetType: 'OrderConfirmation', targetId: f.orderId } })).toBe(before);
  });
  it('rejects signing request sources outside the current sales account order scope', async () => {
    const f = await pending();
    const outsider = await actor(SYSTEM_ROLE_IDS.SALES, 'outside-order-scope');
    const before = await db().approvalRequest.count({ where: { targetType: 'OrderConfirmation', targetId: f.orderId } });
    const denied = await request(f.application).post(`/api/v2/orders/${f.orderId}/request-sign`)
      .set('Authorization', `Bearer ${outsider.token}`).send({});
    expect(denied.status, diagnostic(denied.body)).toBe(403);
    expect(await db().approvalRequest.count({ where: { targetType: 'OrderConfirmation', targetId: f.orderId } })).toBe(before);
  });
  it('rejects a reviewed approval after leadership grants are withdrawn', async () => {
    const f = await pending();
    await db().userRole.deleteMany({ where: { userId: f.reviewerActor.userId } });
    const denied = await request(f.application).post(`/api/v1/approvals/${f.approvalId}/decide`)
      .set('Authorization', `Bearer ${f.reviewerToken}`).send(f.signBody);
    expect(denied.status, diagnostic(denied.body)).toBe(403);
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } })).status).toBe('pending');
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
      action: 'approve_business_request' } })).toBe(0);
  });

  it('freezes the full composite contract and dynamic clauses without registering a trade document', async () => {
    const f = await pending();
    const requester = await actor(SYSTEM_ROLE_IDS.LOGISTICS, 'contract-requester');
    const otherId = `${prefix}-contract-order-${++sequence}`;
    seededOrderIds.push(otherId);
    await db().order.create({ data: { id: otherId, poNumber: `${otherId}-PO`, customer: 'Synthetic customer',
      product: 'Synthetic fabric', type: 'fabric', businessLine: 'fabric', quantity: '2', unit: 'M', status: 'Confirmed',
      dueDate: '2099-01-01', quoteAmount: '8', currency: 'USD', ownerId: f.requester.id, updatedAt: BigInt(Date.now()),
      paymentTerms: '30 days', deliveryTerms: 'FOB', claimPeriodDays: 10, shipmentDate: '2098-12-01' } });
    await db().orderLine.create({ data: { id: `${otherId}-line`, orderId: otherId, lineNumber: 1,
      description: 'Synthetic second agreed fabric', quantity: '2', unit: 'M', unitPrice: '4', netValue: '8' } });
    const documentsBefore = await db().tradeDocument.count();
    const sent = await request(f.application).post('/api/v1/customs/trade-documents/composite/request-sign')
      .set('Authorization', `Bearer ${requester.token}`).send({ kind: 'CONTRACT', sourceIds: [f.orderId, otherId] });
    expect(sent.status, diagnostic(sent.body)).toBe(201);
    const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: sent.body.approvalId } });
    const loaded = await loadUserWithRoles(db(), approval.reviewerId!);
    const reviewer = await buildLoadedAuthTokenPayload(db(), loaded);
    const token = auth.signToken(reviewer);
    const detail = await request(f.application).get(`/api/v1/approvals/${approval.id}/detail`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status, diagnostic(detail.body)).toBe(200);
    expect(detail.body.detail.canApprove, diagnostic(detail.body)).toBe(true);
    const approved = await request(f.application).post(`/api/v1/approvals/${approval.id}/decide`)
      .set('Authorization', `Bearer ${token}`).send({ status: 'approved', confirmedReviewedContent: true,
        reviewContentVersion: detail.body.detail.reviewContentVersion, reviewPreviewDigest: detail.body.detail.frozen.previewDigest });
    expect(approved.status, diagnostic(approved.body)).toBe(200);
    const signer = await resolveDocumentSigner(db(), { targetType: 'Contract', targetId: sent.body.sourceRef });
    expect(signer?.userId).toBe(reviewer.userId);
    expect(signer?.documentSnapshot?.sourceIds).toEqual([f.orderId, otherId]);
    expect(signer?.documentSnapshot?.clauses?.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(signer?.documentSnapshot?.clauses)).toContain('10');
    expect(await db().tradeDocument.count()).toBe(documentsBefore);
    await db().order.update({ where: { id: otherId }, data: { claimPeriodDays: 20 } });
    expect(await resolveDocumentSigner(db(), { targetType: 'Contract', targetId: sent.body.sourceRef })).toBeNull();
  });

  it('freezes the reviewed document, signs with the current actual reviewer, and preserves order facts', async () => {
    const f = await pending();
    const before = await db().orderLine.findUnique({ where: { id: f.lineId } });
    const response = await request(f.application).post(`/api/v1/approvals/${f.approvalId}/decide`)
      .set('Authorization', `Bearer ${f.reviewerToken}`).send(f.signBody);
    expect(response.status, diagnostic(response.body)).toBe(200);
    const signer = await resolveDocumentSigner(db(), { targetType: 'OrderConfirmation', targetId: f.orderId });
    expect(signer?.userId).toBe(f.reviewerActor.userId);
    expect(signer?.documentSnapshot?.exactSource.order.lines[0].unitPrice).toBe('4');
    expect(await db().orderLine.findUnique({ where: { id: f.lineId } })).toEqual(before);
    const again = await request(f.application).post(`/api/v1/approvals/${f.approvalId}/decide`)
      .set('Authorization', `Bearer ${f.reviewerToken}`).send(f.signBody);
    expect(again.status, diagnostic(again.body)).toBe(409);
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
      action: 'approve_business_request' } })).toBe(1);
  });
  it('refuses an old review after current source terms change without committing a decision', async () => {
    const f = await pending();
    await db().orderLine.update({ where: { id: f.lineId }, data: { unitPrice: '5', netValue: '15' } });
    const response = await request(f.application).post(`/api/v1/approvals/${f.approvalId}/decide`)
      .set('Authorization', `Bearer ${f.reviewerToken}`).send(f.signBody);
    expect(response.status, diagnostic(response.body)).toBe(409);
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } })).status).toBe('pending');
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
      action: 'approve_business_request' } })).toBe(0);
  });
  it('does not stamp changed terms with an earlier approved signature', async () => {
    const f = await pending();
    const response = await request(f.application).post(`/api/v1/approvals/${f.approvalId}/decide`)
      .set('Authorization', `Bearer ${f.reviewerToken}`).send(f.signBody);
    expect(response.status, diagnostic(response.body)).toBe(200);
    await db().orderLine.update({ where: { id: f.lineId }, data: { unitPrice: '5', netValue: '15' } });
    expect(await resolveDocumentSigner(db(), { targetType: 'OrderConfirmation', targetId: f.orderId })).toBeNull();
  });
});
