import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createFinanceRouter } from '../route';
import { previewDevelopmentExpenseReview, confirmDevelopmentExpenseReview } from '../../development/developmentClosureService';
import { buildInvoiceMutationError } from '../../agent/invoiceMutationFlow';

// Actual HTTP/domain error-boundary contract, not proof of PG writes, locks,
// rollback or current DB authorization. Storage is deliberately an in-memory seam.
// The prior review is produced by the real preview/confirm service, not a guard mock.
const actor: TokenPayload = { userId: 'invoice-error-actor', roles: [], roleIds: ['invoice-error-custom'],
  permissions: ['invoices:write'], departmentIds: [], authorizationLoaded: true };

function cloneStored(value: any): any {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneStored);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneStored(item)]));
  return value;
}

async function fixture() {
  const state: any = {
    development: { id: 'dev-case', stage: 'approved', updatedAt: 1n },
    lifecycle: { id: 'dev-closed', state: 'closed', revision: 1 },
    reviews: [], coverage: [], costs: [], task: null, audits: [],
    billing: { id: 'billing', sourceType: 'DevelopmentCase', sourceId: 'dev-case', status: 'confirmed',
      developmentExpenseReviewId: null, amount: new Prisma.Decimal(50), waivedAmount: new Prisma.Decimal(0),
      offsetAmount: new Prisma.Decimal(0), currency: 'CNY', bearerType: 'customer', bearerRelationId: 'customer', invoiceId: null },
    invoice: { id: 'invoice', invoiceNumber: 'INV-ERROR', type: 'Receivable', status: 'Draft', deletedAt: null,
      sourceType: 'BillingItem', sourceId: 'billing', amount: new Prisma.Decimal(50), currency: 'CNY',
      customerRelationId: 'customer', issueDate: '2026-10-01' },
  };
  const storedUser = { id: actor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: actor.roleIds![0], departmentId: null, role: { id: actor.roleIds![0],
      permissions: actor.permissions!.map(scope => ({ permission: { scope } })) } }] };
  const findUser = vi.fn(async ({ where }: any) => where.id === storedUser.id ? storedUser : null);
  state.invoice.ownerId = actor.userId;
  const tx: any = {
    userAccount: { findUnique: findUser, findFirst: findUser },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'locked-source' }]),
    billingItem: { findFirst: vi.fn(async () => state.billing) },
    developmentCase: { findFirst: vi.fn(async () => state.development) },
    developmentLifecycleEvent: { findFirst: vi.fn(async () => state.lifecycle) },
    developmentExpenseReview: {
      findMany: vi.fn(async () => state.reviews),
      findFirst: vi.fn(async ({ where }: any) => state.reviews.find((r: any) => r.id === where.id && r.developmentCaseId === where.developmentCaseId) ?? null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { state.reviews.push(data); return data; }),
    },
    sampleBatch: { findMany: vi.fn(async () => []) }, sample: { findMany: vi.fn(async () => []) },
    sealSample: { findMany: vi.fn(async () => []) }, developmentPendingExpense: { findMany: vi.fn(async () => []) },
    costRecord: { findMany: vi.fn(async () => state.costs) },
    billingItemCostCoverage: { findMany: vi.fn(async () => state.coverage) },
    workAssignment: { findUnique: vi.fn(async () => state.task) },
    auditLog: { create: vi.fn(async ({ data }: any) => { state.audits.push(data); return data; }) },
    invoice: {
      findUnique: vi.fn(async () => state.invoice),
      findFirst: vi.fn(async ({ where }: any) => state.invoice?.id === where.id && !state.invoice.deletedAt ? state.invoice : null),
      create: vi.fn(async ({ data }: any) => { state.invoice = { ...data, deletedAt: null }; return state.invoice; }),
      update: vi.fn(async ({ data }: any) => { state.invoice = { ...state.invoice, ...data }; return state.invoice; }),
    },
    invoiceAllocation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    invoiceOrderAllocation: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})) },
    relation: { findUnique: vi.fn(async () => null) },
  };
  const db: any = { ...tx, $transaction: vi.fn(async (work: any) => { const before = cloneStored(state); try { return await work(tx); } catch (error) { Object.assign(state, before); throw error; } }) };
  const context = { prisma: db, actorId: actor.userId, authorize: vi.fn(async () => undefined) };
  const preview = await previewDevelopmentExpenseReview(context, 'dev-case');
  const review = await confirmDevelopmentExpenseReview(context, 'dev-case', {
    expectedFingerprint: preview.fingerprint, requestKey: 'native-prior-review', note: '费用来源已核齐',
  });
  state.billing.developmentExpenseReviewId = review.id;
  tx.auditLog.create.mockClear();
  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/finance', createFinanceRouter({ prisma: db, requireAuth: true, apiKeys: new Set(), onDataChange }));
  const token = createAuthService().signToken(actor);
  const submit = (mode: 'create' | 'issue') => mode === 'create'
    ? request(app).post('/finance').set('Authorization', `Bearer ${token}`).send({
      invoiceNumber: 'INV-ERROR-CREATE', type: 'Receivable', status: 'Draft', amount: '50', currency: 'CNY',
      customerRelationId: 'customer', sourceType: 'BillingItem', sourceId: 'billing', issueDate: '2026-10-01',
    })
    : request(app).patch('/finance/invoice').set('Authorization', `Bearer ${token}`).send({ status: 'Issued' });
  const noInvoiceMutation = () => {
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
    expect(state.audits).toHaveLength(1); // native prior-review audit remains.
  };
  return { state, tx, db, submit, noInvoiceMutation, onDataChange };
}

describe('invoice preserves native whole-case refusal and safe unknown failures', () => {
  it('permits the unchanged native-reviewed source as a technical positive control', async () => {
    const f = await fixture(), review = structuredClone(f.state.reviews[0]);
    const res = await f.submit('create');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'Receivable', status: 'Draft', sourceType: 'BillingItem', sourceId: 'billing', amount: 50 });
    expect(f.tx.invoice.create).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.onDataChange).toHaveBeenCalledTimes(1);
    expect(f.state.reviews).toEqual([review]);
    expect(f.state.audits).toHaveLength(2);
  });

  it.each(['create', 'issue'] as const)('%s: missing native review retains REVIEW_REQUIRED 409', async mode => {
    const f = await fixture();
    f.state.reviews = [];
    const res = await f.submit(mode);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'REVIEW_REQUIRED', message: '缺少本案费用核齐记录' } });
    f.noInvoiceMutation();
  });

  it.each(['create', 'issue'] as const)('%s: changed source retains REVIEW_STALE 409 and immutable original review', async mode => {
    const f = await fixture(), prior = structuredClone(f.state.reviews[0]);
    f.state.development.updatedAt = 2n;
    const res = await f.submit(mode);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'REVIEW_STALE', message: '费用核齐依据已变化，请重新核齐' } });
    expect(f.state.reviews).toEqual([prior]);
    f.noInvoiceMutation();
  });

  it.each(['create', 'issue'] as const)('%s: mismatching coverage retains COVERAGE_CONFLICT 409', async mode => {
    const f = await fixture();
    f.state.coverage = [{ costRecordId: 'extra-cost', costAmount: '1', costCurrency: 'CNY' }];
    const res = await f.submit(mode);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'COVERAGE_CONFLICT', message: '收费覆盖与核齐费用不一致，请重新核对' } });
    f.noInvoiceMutation();
  });

  it.each(['create', 'issue'] as const)('%s: wrong managed billing source retains INVALID_BILLING_SOURCE 409', async mode => {
    const f = await fixture();
    f.state.billing.sourceType = 'Order';
    const res = await f.submit(mode);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'INVALID_BILLING_SOURCE', message: '缺少本案核齐依据' } });
    f.noInvoiceMutation();
  });

  it('create: mismatching actual task contents retains HANDOFF_CONFLICT 409', async () => {
    const f = await fixture();
    f.state.task = { id: 'managed-task', status: 'assigned', deletedAt: null, metadata: {
      managedBy: 'development_cost_closure', caseId: 'dev-case', billingItemId: 'billing',
      reviewId: f.state.billing.developmentExpenseReviewId, currency: 'CNY', bearerRelationId: 'customer',
      amount: '51', waivedAmount: '0', offsetAmount: '0',
    } };
    const res = await f.submit('create');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'HANDOFF_CONFLICT', message: '收费金额、减免或客户与财务交接依据不一致，请核对原交接记录' } });
    f.noInvoiceMutation();
  });

  it.each(['create', 'issue'] as const)('%s: typed dependency details survive the actual HTTP envelope', async mode => {
    const f = await fixture(), details = { reviewId: 'prior-review', costIds: ['cost-one'] };
    // Transport contract for a typed dependency: no source guard is replaced.
    f.tx.$queryRaw.mockRejectedValueOnce(Object.assign(new Error('明确的核齐冲突'), {
      code: 'COVERAGE_CONFLICT', statusCode: 409, gateDetails: details,
    }));
    const res = await f.submit(mode);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'COVERAGE_CONFLICT', message: '明确的核齐冲突', details } });
    f.noInvoiceMutation();
  });

  it.each(['create', 'issue'] as const)('%s: actual source read exceptions stay safe 500 even when their text resembles validation', async mode => {
    const f = await fixture();
    f.tx.costRecord.findMany.mockRejectedValueOnce(Object.assign(new Error('SELECT secret_cost.secret_amount 不存在 必填 /private/database'), { code: 'P2010' }));
    const res = await f.submit(mode);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: mode === 'create' ? 'CREATE_FAILED' : 'UPDATE_FAILED',
      message: mode === 'create' ? '发票创建结果暂不可确认，请先核对原发票记录后重试。' : '发票更新结果暂不可确认，请先刷新核对原发票记录后重试。' } });
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|secret_cost|secret_amount|private|P2010|已回滚/);
    f.noInvoiceMutation();
  });

  it('a registered-looking code without the explicit business status cannot expose driver text or become 409', async () => {
    const f = await fixture();
    f.tx.costRecord.findMany.mockRejectedValueOnce(Object.assign(new Error('secret SQL source'), { code: 'REVIEW_STALE' }));
    const res = await f.submit('create');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    expect(res.body.error.message).toBe('发票创建结果暂不可确认，请先核对原发票记录后重试。');
    f.noInvoiceMutation();
  });

  it.each(['CREATE_FAILED', 'UPDATE_FAILED'] as const)('Agent %s feedback requests source verification without promising rollback', code => {
    const error = buildInvoiceMutationError(code, '服务返回失败');
    expect(error.code).toBe(code);
    expect(error.message).toBe('服务返回失败');
    expect(error.userAction).toBe(code === 'CREATE_FAILED'
      ? '发票创建结果暂不可确认，请先核对原发票记录后重试'
      : '发票更新结果暂不可确认，请先刷新核对原发票记录后重试');
    expect(error.userAction).not.toContain('已回滚');
  });
});
