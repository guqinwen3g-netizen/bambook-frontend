/**
 * Isolated PostgreSQL acceptance of the native development-fee approval chain.
 * Uses only canonical sales, sales-manager, and finance role grants. The final
 * fee proposal remains pending until the leader's single atomic decision;
 * actual CostRecord and ExpenseReview rows stay immutable throughout.
 */
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
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS, SYSTEM_ROLE_META, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createDevelopmentClosureRouter } from '../src/development/developmentClosureRoute';
import { createCostRecordInTx } from '../src/finance/billingItemService';
import { developmentBillingReviewTaskId } from '../src/development/developmentBillingWorkflowService';
import { developmentFinanceTaskId } from '../src/development/developmentFinanceTask';
import { decideDevelopmentBillingApproval } from '../src/development/developmentBillingApprovalService';
import { addRealtimeClient } from '../src/realtime';
import { parseNotificationLink } from '../../services/crossModuleNav';
import { View } from '../../types';

const prefix = `acceptance-development-fee-${randomUUID()}`;
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
const seededUserIds: string[] = [];

function db(): PrismaClient {
  if (!prisma) throw new Error('Development fee acceptance requires the verified isolated PostgreSQL client');
  return prisma;
}

const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

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

  // Provision the built-in production role matrix. No personal permission
  // override and no test-only role-to-scope mapping is used.
  const roleIds = Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[];
  for (const roleId of roleIds) {
    await db().role.upsert({ where: { id: roleId }, update: {},
      create: { id: roleId, name: SYSTEM_ROLE_META[roleId].name, description: SYSTEM_ROLE_META[roleId].description, isSystem: true } });
  }
  const scopes = [...new Set(roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId)))];
  await db().permission.createMany({ data: scopes.map(scope => ({ id: `${prefix}-permission-${scope}`, scope })), skipDuplicates: true });
  const permissions = await db().permission.findMany({ where: { scope: { in: scopes } }, select: { id: true, scope: true } });
  const permissionIds = new Map(permissions.map(permission => [permission.scope, permission.id]));
  await db().rolePermission.createMany({ data: roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId).map(scope => ({
    id: `${prefix}-role-grant-${roleId}-${scope}`, roleId, permissionId: permissionIds.get(scope)!,
  }))), skipDuplicates: true });
});

afterAll(async () => {
  if (!prisma) return;
  try {
    // The reviewed runner owns a disposable private database; retain synthetic
    // facts for post-run inspection and only close the client here.
    expect(await db().userPermissionOverrides.count({ where: { userId: { in: seededUserIds } } })).toBe(0);
  } finally { await prisma.$disconnect(); }
});

type ActorFixture = { id: string; roleId: SystemRoleId; actor: TokenPayload; token: string };
type Fixture = {
  caseId: string; customerId: string; departmentId: string; sales: ActorFixture; leader: ActorFixture; finance: ActorFixture;
  app: express.Express; costRecordId?: string; reviewId?: string; billingItemId?: string; approvalId?: string;
};

async function createActor(roleId: SystemRoleId, label: string, departmentId: string): Promise<ActorFixture> {
  const id = `${prefix}-${++sequence}-${label}`;
  await db().userAccount.create({ data: { id, displayName: `Synthetic ${SYSTEM_ROLE_META[roleId].name} ${id}`, status: 'active', primaryDeptId: departmentId } });
  await db().userRole.create({ data: { id: `${id}-membership`, userId: id, roleId, departmentId } });
  seededUserIds.push(id);
  const loaded = await loadUserWithRoles(db(), id);
  if (!loaded) throw new Error(`Synthetic canonical actor ${id} did not load`);
  const actor = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(actor.roleIds).toContain(roleId);
  expect(actor.permissions).toEqual(expect.arrayContaining(getDatabaseSeedScopeListForRole(roleId)));
  expect(await db().userPermissionOverrides.count({ where: { userId: id } })).toBe(0);
  return { id, roleId, actor, token: auth.signToken(actor) };
}

function application(): express.Express {
  const app = express();
  app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/development', createDevelopmentClosureRouter({ prisma: db() }));
  app.use('/api/v1/approvals', createApprovalRouter({ prisma: db(), requireAuth: true }));
  return app;
}

function bearer(actor: ActorFixture): string { return `Bearer ${actor.token}`; }

async function ok(response: request.Response, expected = 200): Promise<any> {
  expect(response.status, `expected HTTP ${expected}: ${diagnostic(response.body)}`).toBe(expected);
  return response.body;
}

function expectDevelopmentFeeNotificationTarget(link: string | null, caseId: string) {
  expect(link).toEqual(expect.any(String));
  expect(parseNotificationLink(link)).toEqual({ view: View.Development, id: caseId, tab: 'fees', params: {} });
}

async function fixture(label: string): Promise<Fixture> {
  const caseId = `${prefix}-${++sequence}-${label}-case`;
  const customerId = `${caseId}-customer`, departmentId = `${caseId}-department`;
  const leaderId = `${caseId}-leader`;
  await db().userAccount.create({ data: { id: leaderId, displayName: `Synthetic department leader ${label}`, status: 'active' } });
  seededUserIds.push(leaderId);
  await db().department.create({ data: { id: departmentId, name: `Acceptance ${label}`, status: 'active', headId: leaderId } });
  await db().userAccount.update({ where: { id: leaderId }, data: { primaryDeptId: departmentId } });
  await db().userRole.create({ data: { id: `${leaderId}-membership`, userId: leaderId,
    roleId: SYSTEM_ROLE_IDS.SALES_MANAGER, departmentId } });
  const sales = await createActor(SYSTEM_ROLE_IDS.SALES, `${label}-sales`, departmentId);
  const leaderLoaded = await loadUserWithRoles(db(), leaderId);
  if (!leaderLoaded) throw new Error('Synthetic canonical leader did not load');
  const leaderActor = await buildLoadedAuthTokenPayload(db(), leaderLoaded);
  expect(leaderActor.roleIds).toContain(SYSTEM_ROLE_IDS.SALES_MANAGER);
  expect(leaderActor.permissions).toEqual(expect.arrayContaining(getDatabaseSeedScopeListForRole(SYSTEM_ROLE_IDS.SALES_MANAGER)));
  expect(await db().userPermissionOverrides.count({ where: { userId: leaderId } })).toBe(0);
  const leader: ActorFixture = { id: leaderId, roleId: SYSTEM_ROLE_IDS.SALES_MANAGER, actor: leaderActor, token: auth.signToken(leaderActor) };
  const finance = await createActor(SYSTEM_ROLE_IDS.FINANCE, `${label}-finance`, departmentId);
  await db().relation.create({ data: { id: customerId, name: `Synthetic customer ${label}`, category: 'customer', type: 'company',
    isOrganization: true, ownerId: sales.id, departmentId, salesRepIds: [sales.id, leader.id], tags: [], contactInfo: '{}',
    lastInteraction: BigInt(Date.now()) } });
  await db().developmentCase.create({ data: { id: caseId, code: caseId, name: `Synthetic fee case ${label}`,
    type: 'garment', stage: 'developing', customerRelationId: customerId, customerName: `Synthetic customer ${label}`, tags: [],
    createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  return { caseId, customerId, departmentId, sales, leader, finance, app: application() };
}

async function addActualCost(f: Fixture, amount = '37.2500') {
  const row = await db().$transaction(tx => createCostRecordInTx(tx, { actorId: f.sales.id, input: {
    sourceType: 'DevelopmentCase', sourceId: f.caseId, costType: 'testing', amount, currency: 'CNY',
    incurredAt: '2026-10-04', notes: 'Synthetic received supplier bill; immutable actual cost fact',
  } }));
  f.costRecordId = row.id;
  return row;
}

async function prepareApproval(f: Fixture, input: { amount: string; waivedAmount: string }) {
  await addActualCost(f);
  const sales = bearer(f.sales), root = `/api/v1/development/${f.caseId}`;
  const close = (await ok(await request(f.app).get(`${root}/closure-preview`).set('Authorization', sales))).closure;
  await ok(await request(f.app).post(`${root}/lifecycle`).set('Authorization', sales).send({
    action: 'close', outcome: 'stopped', reason: 'Synthetic case ended; customer charge requires separate financial decision',
    disposition: 'Finance reviews the customer fee after leadership approval', expectedRevision: close.revision,
    expectedFingerprint: close.fingerprint, requestKey: `${f.caseId}-close`,
  }));
  const expense = (await ok(await request(f.app).get(`${root}/expense-review-preview`).set('Authorization', sales))).review;
  const review = (await ok(await request(f.app).post(`${root}/expense-reviews`).set('Authorization', sales).send({
    expectedFingerprint: expense.fingerprint, requestKey: `${f.caseId}-expense-review`,
    note: 'All actual case costs received and checked against current records',
  }))).review;
  f.reviewId = review.id;
  const draft = await ok(await request(f.app).post(`${root}/billing-drafts`).set('Authorization', sales).send({
    requestKey: `${f.caseId}-draft`, reviewId: review.id, amount: input.amount, waivedAmount: input.waivedAmount,
    currency: 'CNY', note: 'Customer charge proposal; actual cost remains an independent immutable fact',
  }));
  const billingItem = draft.billingItem;
  expect(billingItem).toMatchObject({ developmentWorkflowState: 'draft', developmentWorkflowVersion: 0 });
  f.billingItemId = billingItem.id;
  const submission = await ok(await request(f.app).post(`${root}/billing-drafts/${billingItem.id}/workflow`)
    .set('Authorization', sales).send({ action: 'submit', requestKey: `${f.caseId}-submit`, expectedVersion: 0,
      note: 'Customer charge and discount submitted for required leadership review', reviewId: review.id, userId: f.finance.id }));
  f.approvalId = submission.billingItem.developmentApprovalId;
  const requiresLeadership = Number(input.amount) === 0 || Number(input.waivedAmount) > 0;
  if (!requiresLeadership) {
    expect(submission.billingItem.developmentWorkflowState).toBe('submitted');
    expect(await db().workAssignment.count({ where: { id: developmentBillingReviewTaskId(billingItem.id, 1) } })).toBe(1);
    return { review, billingItem };
  }
  expect(submission.billingItem.developmentWorkflowState).toBe('approval_pending');
  if (!f.approvalId) throw new Error('Discount or free-charge proposal did not create a leadership approval');
  const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } });
  expect(approval.status).toBe('pending'); expect(approval.reviewerId).toBe(f.leader.id);
  expect(await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(0);
  const leaderNotification = await db().notification.findUniqueOrThrow({ where: { id: `ntf_dev_fee_approval_${f.approvalId}` } });
  expect(leaderNotification).toMatchObject({
    userId: f.leader.id, type: 'development_fee_approval_requested',
  });
  expectDevelopmentFeeNotificationTarget(leaderNotification.link, f.caseId);
  return { review, billingItem };
}

async function reviewedApproval(f: Fixture) {
  const response = await ok(await request(f.app).get(`/api/v1/approvals/${f.approvalId}/detail`).set('Authorization', bearer(f.leader)));
  expect(response.detail.approvalId).toBe(f.approvalId);
  expect(response.detail.currentSource.status).toBe('available');
  const item = await ok(await request(f.app).get(`/api/v1/approvals/${f.approvalId}`).set('Authorization', bearer(f.leader)));
  expect(item.item.reviewContentVersion).toBe(response.detail.reviewContentVersion);
  return { detail: response.detail, item: item.item };
}

async function verifyAtFinance(f: Fixture, version: number) {
  const taskId = developmentBillingReviewTaskId(f.billingItemId!, version);
  const evidence = await ok(await request(f.app).get(`/api/v1/development/finance-tasks/${taskId}/expense-evidence`)
    .set('Authorization', bearer(f.finance)));
  expect(evidence.current).toBe(true);
  const root = `/api/v1/development/${f.caseId}/billing-drafts/${f.billingItemId}/workflow`;
  const result = await ok(await request(f.app).post(root).set('Authorization', bearer(f.finance)).send({
    action: 'verify', requestKey: `${f.caseId}-verify`, expectedVersion: version,
    note: 'Financial basis, approved customer amount and immutable cost records verified',
  }));
  expect(result.billingItem).toMatchObject({ developmentWorkflowState: 'ready', developmentWorkflowVersion: version + 1 });
  const handoff = await db().workAssignment.findUniqueOrThrow({ where: { id: developmentFinanceTaskId(f.billingItemId!) } });
  expect(handoff).toMatchObject({ userId: f.finance.id, status: 'assigned' });
  expect(handoff.metadata).toMatchObject({ caseId: f.caseId, billingItemId: f.billingItemId, kind: 'finance_handoff' });
  return { taskId, evidence, handoff };
}

function capture(userId: string) {
  let value = '';
  const stop = addRealtimeClient({ write: (chunk: string) => { value += chunk; return true; } } as any, userId);
  value = '';
  return { stop, get value() { return value; } };
}

describe.sequential('development fee leadership and finance handoff in actual PostgreSQL', () => {
  it('requires leadership for a customer discount, approves the frozen amount in one commit, and hands off once to finance', async () => {
    const f = await fixture('normal-approval');
    const streams = [capture(f.sales.id), capture(f.leader.id), capture(f.finance.id)];
    try {
      const { review, billingItem } = await prepareApproval(f, { amount: '100.0000', waivedAmount: '15.0000' });
      const initial = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
      expect(initial).toMatchObject({ status: 'draft', developmentWorkflowState: 'approval_pending' });
      expect(initial.amount.toString()).toBe('100'); expect(initial.waivedAmount.toString()).toBe('15');
      expect(streams[1].value).toContain('development_fee_approval_requested');
      expect(streams[0].value).not.toContain('development_fee_approval_requested');
      expect(streams[2].value).not.toContain('development_fee_approval_requested');
      const { detail } = await reviewedApproval(f);
      const decisionBody = { status: 'approved', reviewContentVersion: detail.reviewContentVersion,
        confirmedReviewedContent: true, decisionNote: 'Original customer fee and discount approved for finance verification' };
      const approved = await ok(await request(f.app).post(`/api/v1/approvals/${f.approvalId}/decide`)
        .set('Authorization', bearer(f.leader)).send(decisionBody));
      expect(approved.item.status).toBe('approved');
      expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } })).toMatchObject({ status: 'approved' });
      const requesterReadback = await ok(await request(f.app).get(`/api/v1/approvals/${f.approvalId}`)
        .set('Authorization', bearer(f.sales)));
      expect(requesterReadback.item).toMatchObject({ id: f.approvalId, status: 'approved',
        requesterId: f.sales.id, reviewerId: f.leader.id, actionType: 'development:fee' });
      const row = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
      expect(row).toMatchObject({ status: 'draft', developmentWorkflowState: 'submitted',
        developmentAssigneeId: f.finance.id, developmentWorkflowVersion: 2 });
      expect(row.amount.toString()).toBe('100'); expect(row.waivedAmount.toString()).toBe('15');
      const fact = await db().auditLog.findFirstOrThrow({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
        action: 'approve_business_request' } });
      expect((fact.detail as any).approvalDecisionFact).toMatchObject({ status: 'approved', actionType: 'development:fee',
        reviewedContentConfirmed: true, reviewPreviewDigest: null });
      expect((fact.detail as any).approvalDecisionFact).not.toHaveProperty('modifiedInput');
      const effectsBeforeDuplicate = {
        approvalAudits: await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
          action: { in: ['approve_business_request', 'reject_business_request'] } } }),
        tasks: await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } }),
        notifications: await db().notification.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } }),
      };
      const duplicate = await request(f.app).post(`/api/v1/approvals/${f.approvalId}/decide`).set('Authorization', bearer(f.leader)).send(decisionBody);
      expect(duplicate.status).toBe(404);
      expect(duplicate.body.error).toBe('开发费用审批不存在');
      let duplicateReachedKernel = false;
      const duplicateDomainError = await decideDevelopmentBillingApproval({
        prisma: db(), decisionService: { decideInTransaction: async () => {
          duplicateReachedKernel = true; throw new Error('Resolved approvals must stop in the fee adapter');
        } }, approvalId: f.approvalId!, actor: { userId: f.leader.id }, status: 'approved',
        reviewContentVersion: detail.reviewContentVersion, confirmedReviewedContent: true,
        authorizeBusiness: async () => undefined, authorizeRecipient: async () => undefined,
      }).catch(error => error as Error & { code?: string; statusCode?: number });
      expect(duplicateDomainError).toMatchObject({ code: 'APPROVAL_NOT_FOUND', statusCode: 404 });
      expect(duplicateReachedKernel).toBe(false);
      expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
        action: { in: ['approve_business_request', 'reject_business_request'] } } })).toBe(effectsBeforeDuplicate.approvalAudits);
      expect(await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(effectsBeforeDuplicate.tasks);
      expect(await db().notification.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(effectsBeforeDuplicate.notifications);
      expect(await db().workAssignment.count({ where: { id: developmentBillingReviewTaskId(billingItem.id, 2) } })).toBe(1);
      const financeNotification = await db().notification.findUniqueOrThrow({ where: { id: `ntf_dev_fee_review_${fact.id}` } });
      expect(financeNotification).toMatchObject({ userId: f.finance.id, type: 'development_fee_review_requested',
      });
      expectDevelopmentFeeNotificationTarget(financeNotification.link, f.caseId);
      expect(await db().notification.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(2);
      expect(streams[2].value).toContain('development_fee_review_requested');
      expect(streams[0].value).not.toContain('development_fee_review_requested');
      const handoff = await verifyAtFinance(f, 2);
      expect(handoff.evidence.review.id).toBe(review.id);
      const [cost, storedReview] = await Promise.all([
        db().costRecord.findUniqueOrThrow({ where: { id: f.costRecordId! } }),
        db().developmentExpenseReview.findUniqueOrThrow({ where: { id: review.id } }),
      ]);
      expect(cost.amount.toString()).toBe('37.25'); expect(cost.currency).toBe('CNY');
      expect(storedReview.fingerprint).toBe(review.fingerprint); expect(storedReview.snapshot).toEqual(review.snapshot);
      expect(await db().developmentBillingWorkflowEvent.count({ where: { billingItemId: billingItem.id, action: 'approval_approved' } })).toBe(1);
    } finally { streams.forEach(stream => stream.stop()); }
  });

  it('previews an amended fee without writes and applies its exact digest only with the single approval transaction', async () => {
    const f = await fixture('modified-approval');
    const { review, billingItem } = await prepareApproval(f, { amount: '120.0000', waivedAmount: '20.0000' });
    const { detail } = await reviewedApproval(f);
    const finalInput = { amount: '110', waivedAmount: '10', reason: 'Final customer discount after reviewing case and expense basis' };
    const before = {
      approval: await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId! } }),
      item: await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } }),
      workflowEvents: await db().developmentBillingWorkflowEvent.count({ where: { billingItemId: billingItem.id } }),
      audits: await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId } }),
      assignments: await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } }),
      notifications: await db().notification.count({ where: { userId: { in: [f.leader.id, f.finance.id] }, metadata: { path: ['billingItemId'], equals: billingItem.id } } }),
    };
    const preview = (await ok(await request(f.app).post(`/api/v1/approvals/${f.approvalId}/development-fee-preview`)
      .set('Authorization', bearer(f.leader)).send({ reviewContentVersion: detail.reviewContentVersion, finalInput }))).preview;
    expect(preview).toMatchObject({ approvalId: f.approvalId, reviewContentVersion: detail.reviewContentVersion,
      sourceBillingItemVersion: 1, finalInput, diff: expect.arrayContaining([
        { field: 'amount', before: '120', after: '110' }, { field: 'waivedAmount', before: '20', after: '10' },
      ]) });
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId! } })).toEqual(before.approval);
    expect(await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } })).toEqual(before.item);
    expect(await db().developmentBillingWorkflowEvent.count({ where: { billingItemId: billingItem.id } })).toBe(before.workflowEvents);
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId } })).toBe(before.audits);
    expect(await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(before.assignments);
    expect(await db().notification.count({ where: { userId: { in: [f.leader.id, f.finance.id] }, metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(before.notifications);

    const response = await ok(await request(f.app).post(`/api/v1/approvals/${f.approvalId}/decide`).set('Authorization', bearer(f.leader)).send({
      status: 'approved', reviewContentVersion: detail.reviewContentVersion, confirmedReviewedContent: true,
      decisionNote: 'Final customer fee and discount approved', modifiedInput: preview.finalInput, reviewPreviewDigest: preview.previewDigest,
    }));
    expect(response.item.status).toBe('approved');
    const row = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(row).toMatchObject({ developmentWorkflowState: 'submitted', developmentWorkflowVersion: 2,
      developmentAssigneeId: f.finance.id });
    expect(row.amount.toString()).toBe('110'); expect(row.waivedAmount.toString()).toBe('10');
    const reviewTask = await db().workAssignment.findUniqueOrThrow({ where: { id: developmentBillingReviewTaskId(billingItem.id, 2) } });
    expect(reviewTask.metadata.decision).toEqual({ state: 'submitted', version: 2, reviewId: review.id,
      amount: '110', waivedAmount: '10', offsetAmount: '0', currency: 'CNY', customerId: f.customerId,
      note: finalInput.reason, assigneeId: f.finance.id, submittedBy: f.sales.id });
    const audit = await db().auditLog.findFirstOrThrow({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId,
      action: 'approve_business_request' } });
    expect((audit.detail as any).approvalDecisionFact).toMatchObject({ modifiedInput: preview.finalInput,
      reviewPreviewDigest: preview.previewDigest, reviewedContentConfirmed: true });
    await verifyAtFinance(f, 2);
    const [cost, storedReview] = await Promise.all([
      db().costRecord.findUniqueOrThrow({ where: { id: f.costRecordId! } }),
      db().developmentExpenseReview.findUniqueOrThrow({ where: { id: review.id } }),
    ]);
    expect(cost.amount.toString()).toBe('37.25'); expect(storedReview.fingerprint).toBe(review.fingerprint);
    expect(storedReview.snapshot).toEqual(review.snapshot);
    expect(await db().workAssignment.count({ where: { id: developmentBillingReviewTaskId(billingItem.id, 2) } })).toBe(1);
    expect(await db().workAssignment.count({ where: { id: developmentFinanceTaskId(billingItem.id) } })).toBe(1);
  });

  it('rejection preserves the submitted fee, and a changed resubmission creates a new pending approval while retaining history', async () => {
    const f = await fixture('reject-resubmit');
    const { billingItem, review } = await prepareApproval(f, { amount: '80.0000', waivedAmount: '8.0000' });
    const first = await reviewedApproval(f);
    const rejectedBody = { status: 'rejected', reviewContentVersion: first.detail.reviewContentVersion,
      confirmedReviewedContent: true, rejectionReason: 'The discount basis is incomplete', requestedChanges: 'Attach the final customer charge basis and explain the requested reduction' };
    const rejected = await ok(await request(f.app).post(`/api/v1/approvals/${f.approvalId}/decide`)
      .set('Authorization', bearer(f.leader)).send(rejectedBody));
    expect(rejected.item.status).toBe('rejected');
    const afterReject = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(afterReject).toMatchObject({ status: 'draft', developmentWorkflowState: 'returned', developmentWorkflowVersion: 2 });
    expect(afterReject.amount.toString()).toBe('80'); expect(afterReject.waivedAmount.toString()).toBe('8');
    expect(await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(0);
    expect(await db().billingItemCostCoverage.count({ where: { billingItemId: billingItem.id, releasedAt: null } })).toBeGreaterThan(0);
    expect((await db().costRecord.findUniqueOrThrow({ where: { id: f.costRecordId! } })).amount.toString()).toBe('37.25');
    expect((await db().developmentExpenseReview.findUniqueOrThrow({ where: { id: review.id } })).fingerprint).toBe(review.fingerprint);
    await ok(await request(f.app).post(`/api/v1/development/${f.caseId}/billing-drafts/${billingItem.id}/workflow`)
      .set('Authorization', bearer(f.sales)).send({ action: 'edit', requestKey: `${f.caseId}-edit-after-reject`, expectedVersion: 2,
        note: 'Updated customer proposal after leadership feedback', amount: '78.0000', waivedAmount: '5.0000', currency: 'CNY' }));
    const afterEdit = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(afterEdit.developmentWorkflowVersion).toBe(3);
    expect(afterEdit.amount.toString()).toBe('78'); expect(afterEdit.waivedAmount.toString()).toBe('5');
    const resubmitReview = await db().developmentExpenseReview.findUniqueOrThrow({ where: { id: f.reviewId! } });
    const next = await ok(await request(f.app).post(`/api/v1/development/${f.caseId}/billing-drafts/${billingItem.id}/workflow`)
      .set('Authorization', bearer(f.sales)).send({ action: 'submit', requestKey: `${f.caseId}-resubmit`, expectedVersion: 3,
        note: 'Resubmitted revised customer fee for leadership approval', reviewId: resubmitReview.id, userId: f.finance.id }));
    const secondId = next.billingItem.developmentApprovalId as string;
    expect(secondId).toBeTruthy(); expect(secondId).not.toBe(f.approvalId);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId! } })).toMatchObject({ status: 'rejected' });
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: secondId } })).toMatchObject({ status: 'pending', reviewerId: f.leader.id });
    const resubmitted = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(resubmitted).toMatchObject({ status: 'draft', developmentWorkflowState: 'approval_pending', developmentWorkflowVersion: 4 });
    expect(resubmitted.amount.toString()).toBe('78'); expect(resubmitted.waivedAmount.toString()).toBe('5');
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: f.approvalId!, action: 'reject_business_request' } })).toBe(1);
  });

  it('rejects stale expense versions and revoked leader role with zero approval/fee decision writes', async () => {
    const stale = await fixture('stale-source');
    const { billingItem, review } = await prepareApproval(stale, { amount: '95.0000', waivedAmount: '5.0000' });
    const staleReview = await reviewedApproval(stale);
    const originalCostId = stale.costRecordId!;
    const originalCost = await db().costRecord.findUniqueOrThrow({ where: { id: originalCostId } });
    const beforeFacts = await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: stale.approvalId,
      action: { in: ['approve_business_request', 'reject_business_request'] } } });
    // Add a new real cost event after the expense review. This changes the live
    // source fingerprint without mutating any existing actual-cost row.
    await addActualCost(stale, '1.0000');
    const staleResponse = await request(stale.app).post(`/api/v1/approvals/${stale.approvalId}/decide`).set('Authorization', bearer(stale.leader)).send({
      status: 'approved', reviewContentVersion: staleReview.detail.reviewContentVersion, confirmedReviewedContent: true,
      decisionNote: 'Attempt to approve against old expense basis',
    });
    expect(staleResponse.status).toBe(409);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: stale.approvalId! } })).toMatchObject({ status: 'pending' });
    const staleRow = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(staleRow).toMatchObject({ status: 'draft', developmentWorkflowState: 'approval_pending', developmentWorkflowVersion: 1 });
    expect(staleRow.amount.toString()).toBe('95'); expect(staleRow.waivedAmount.toString()).toBe('5');
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: stale.approvalId,
      action: { in: ['approve_business_request', 'reject_business_request'] } } })).toBe(beforeFacts);
    expect(await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: billingItem.id } } })).toBe(0);
    const originalCostAfter = await db().costRecord.findUniqueOrThrow({ where: { id: originalCostId } });
    expect(originalCostAfter.amount.toString()).toBe(originalCost.amount.toString());
    expect(originalCostAfter.currency).toBe(originalCost.currency);
    const reviewAfter = await db().developmentExpenseReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(reviewAfter.fingerprint).toBe(review.fingerprint); expect(reviewAfter.snapshot).toEqual(review.snapshot);
    expect(await db().costRecord.count({ where: { sourceType: 'DevelopmentCase', sourceId: stale.caseId } })).toBe(2);

    const revoked = await fixture('revoked-leader');
    const revokedData = await prepareApproval(revoked, { amount: '60.0000', waivedAmount: '5.0000' });
    const reviewed = await reviewedApproval(revoked);
    const decisionFacts = await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: revoked.approvalId,
      action: { in: ['approve_business_request', 'reject_business_request'] } } });
    await db().userRole.deleteMany({ where: { userId: revoked.leader.id, roleId: SYSTEM_ROLE_IDS.SALES_MANAGER } });
    const forbidden = await request(revoked.app).post(`/api/v1/approvals/${revoked.approvalId}/decide`).set('Authorization', bearer(revoked.leader)).send({
      status: 'approved', reviewContentVersion: reviewed.detail.reviewContentVersion, confirmedReviewedContent: true,
      decisionNote: 'Attempt after canonical leadership role removal',
    });
    expect(forbidden.status).toBe(403);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: revoked.approvalId! } })).toMatchObject({ status: 'pending' });
    const revokedRow = await db().billingItem.findUniqueOrThrow({ where: { id: revokedData.billingItem.id } });
    expect(revokedRow).toMatchObject({ status: 'draft', developmentWorkflowState: 'approval_pending', developmentWorkflowVersion: 1 });
    expect(revokedRow.amount.toString()).toBe('60'); expect(revokedRow.waivedAmount.toString()).toBe('5');
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: revoked.approvalId,
      action: { in: ['approve_business_request', 'reject_business_request'] } } })).toBe(decisionFacts);
    expect(await db().workAssignment.count({ where: { metadata: { path: ['billingItemId'], equals: revokedData.billingItem.id } } })).toBe(0);
  });

  it('routes an undiscounted customer fee directly to finance without inventing a leadership approval', async () => {
    const f = await fixture('ordinary-fee');
    const { review, billingItem } = await prepareApproval(f, { amount: '37.2500', waivedAmount: '0.0000' });
    expect(f.approvalId).toBeFalsy();
    const row = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(row).toMatchObject({ status: 'draft', developmentWorkflowState: 'submitted',
      developmentAssigneeId: f.finance.id, developmentWorkflowVersion: 1 });
    expect(row.amount.toString()).toBe('37.25'); expect(row.waivedAmount.toString()).toBe('0');
    expect(await db().approvalRequest.count({ where: { targetType: 'BillingItem', targetId: billingItem.id } })).toBe(0);
    expect(await db().workAssignment.count({ where: { id: developmentBillingReviewTaskId(billingItem.id, 1) } })).toBe(1);
    const [cost, storedReview] = await Promise.all([
      db().costRecord.findUniqueOrThrow({ where: { id: f.costRecordId! } }),
      db().developmentExpenseReview.findUniqueOrThrow({ where: { id: review.id } }),
    ]);
    expect(cost.amount.toString()).toBe('37.25'); expect(storedReview.fingerprint).toBe(review.fingerprint);
    await verifyAtFinance(f, 1);
  });

  it('requires leadership approval for a zero-charge customer proposal before finance records the no-receivable outcome', async () => {
    const f = await fixture('zero-charge');
    const { review, billingItem } = await prepareApproval(f, { amount: '0.0000', waivedAmount: '0.0000' });
    expect(f.approvalId).toBeTruthy();
    const { detail } = await reviewedApproval(f);
    const approved = await ok(await request(f.app).post(`/api/v1/approvals/${f.approvalId}/decide`).set('Authorization', bearer(f.leader)).send({
      status: 'approved', reviewContentVersion: detail.reviewContentVersion, confirmedReviewedContent: true,
      decisionNote: 'Zero customer charge approved after reviewing the complete expense basis',
    }));
    expect(approved.item.status).toBe('approved');
    const beforeFinance = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(beforeFinance.developmentWorkflowState).toBe('submitted');
    expect(beforeFinance.amount.toString()).toBe('0'); expect(beforeFinance.waivedAmount.toString()).toBe('0');
    await verifyAtFinance(f, 2);
    const final = await db().billingItem.findUniqueOrThrow({ where: { id: billingItem.id } });
    expect(final.status).toBe('confirmed');
    expect(await db().invoice.count({ where: { sourceType: 'BillingItem', sourceId: billingItem.id } })).toBe(0);
    expect((await db().costRecord.findUniqueOrThrow({ where: { id: f.costRecordId! } })).amount.toString()).toBe('37.25');
    expect((await db().developmentExpenseReview.findUniqueOrThrow({ where: { id: review.id } })).fingerprint).toBe(review.fingerprint);
  });
});
