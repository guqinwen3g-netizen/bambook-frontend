import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../../auth/service';
import * as invoiceMutations from '../../finance/invoiceMutationService';
import { createPricingRouter } from '../pricingRoute';
import { createCommissionPayable, getOrderCommission } from '../commissionPayableService';

// Real router/JWT/commission and, in the positive/post-read controls, the real
// Invoice producer. Storage and current identity are in-memory technical seams:
// these assertions do not establish PostgreSQL rollback or financial settlement.
// The error-family table substitutes only createInvoice's declared return value;
// L/C refusals are adapter controls, not a claim that Payable invoices need L/C.
const permissions = ['pricing:read', 'pricing:write', 'sensitive:commission'];
const actor: TokenPayload = { userId: 'commission-error-finance', roles: ['finance'], roleIds: ['role-finance'],
  departmentIds: [], permissions, authorizationLoaded: true };
const CREATE_COPY = '佣金应付开票结果暂不可确认，请先核对原开票记录后重试。';
const READ_COPY = '读取订单佣金失败，请稍后重试。';
const PRIVATE_SQL = 'SQL SELECT internal_secret FROM Invoice; /private/driver — 不存在、非法、必须';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const state: { invoices: any[]; audits: any[]; committed: boolean; failPostRead: boolean; missingPostRead: boolean; sequence: number } = {
    invoices: [], audits: [], committed: false, failPostRead: false, missingPostRead: false, sequence: 0,
  };
  const user = { id: actor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ departmentId: null, role: { id: 'role-finance', permissions: permissions.map(scope => ({ permission: { scope } })) } }] };
  const db: any = {
    userAccount: { findFirst: vi.fn(async () => user), findUnique: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    order: { findFirst: vi.fn(async ({ where }: any) => where.id === 'commission-order'
      && !(state.committed && state.missingPostRead) ? { id: 'commission-order' } : null) },
    pricingCalculation: { findMany: vi.fn(async () => {
      if (state.committed && state.failPostRead) throw new Error(PRIVATE_SQL);
      return [{ id: 'commission-pricing', orderId: 'commission-order', deletedAt: null, status: 'Confirmed', commissionAmount: new Prisma.Decimal(1), quantity: new Prisma.Decimal(100), commissionRuleId: 'commission-rule' }];
    }) },
    commissionRule: { findMany: vi.fn(async () => [{ id: 'commission-rule', rate: 5,
      intermediaryRelationId: 'commission-intermediary', intermediaryName: 'Actual intermediary', isActive: true, deletedAt: null }]) },
    businessSequence: {
      upsert: vi.fn(async () => ({ seq: state.sequence })),
      update: vi.fn(async () => ({ seq: ++state.sequence })),
    },
    invoice: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (args: any) => state.invoices.filter(row => row.id !== args.where.id?.not)),
      findUnique: vi.fn(async ({ where }: any) => state.invoices.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, deletedAt: null }; state.invoices.push(row); return row;
      }),
    },
    invoiceOrderAllocation: { findMany: vi.fn(async () => []) },
    orderShipmentBatch: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async ({ data }: any) => { state.audits.push(data); return data; }) },
  };
  db.$queryRaw = vi.fn(async () => [{ id: 'commission-order' }]);
  db.$transaction = vi.fn(async (work: any) => {
    const before = { invoices: [...state.invoices], audits: [...state.audits], sequence: state.sequence, committed: state.committed };
    try { const result = await work(db); state.committed = true; return result; }
    catch (error) { Object.assign(state, before); throw error; }
  });
  const onDataChange = vi.fn(), app = express();
  app.use(express.json());
  app.use('/pricing', createPricingRouter({ prisma: db, requireAuth: true, apiKeys: new Set(), onDataChange }));
  const token = createAuthService().signToken(actor);
  const submit = () => request(app).post('/pricing/orders/commission-order/commission/payable')
    .set('Authorization', `Bearer ${token}`).send({ notes: '核对佣金应付' });
  const read = () => request(app).get('/pricing/orders/commission-order/commission').set('Authorization', `Bearer ${token}`);
  const noNativeWrite = (attemptedTransaction = false) => {
    if (attemptedTransaction) {
      expect(db.$transaction).toHaveBeenCalled(); expect(state.committed).toBe(false); expect(state.sequence).toBe(0);
    } else expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled(); expect(state.invoices).toEqual([]); expect(state.audits).toEqual([]);
    expect(onDataChange).not.toHaveBeenCalled();
  };
  return { db, state, submit, read, noNativeWrite, onDataChange };
}

describe('commission Payable preserves Invoice refusal states and safe uncertain results', () => {
  it('creates a native Invoice with exact Order source and audit, then reads the changed balance', async () => {
    const f = fixture(), res = await f.submit();
    expect(res.status).toBe(201);
    expect(res.body.invoice).toMatchObject({ type: 'Payable', status: 'Issued', amount: 100, currency: 'USD',
      orderId: 'commission-order', customerRelationId: 'commission-intermediary', sourceType: 'CommissionPayable', sourceId: 'commission-order#1' });
    expect(res.body.commission).toMatchObject({ totalCommission: 100, invoicedAmount: 100, uninvoicedAmount: 0 });
    expect(f.db.$transaction).toHaveBeenCalledTimes(1); expect(f.db.invoice.create).toHaveBeenCalledTimes(1);
    expect(f.db.auditLog.create).toHaveBeenCalledTimes(1); expect(f.state.committed).toBe(true);
    expect(f.state.audits[0]).toMatchObject({ actorId: actor.userId, action: 'create_invoice', targetId: res.body.invoice.id });
    expect(f.onDataChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['INVALID_STATUS', 400], ['INVALID_TRANSITION', 400], ['INVALID_CURRENT_STATUS', 400],
    ['INVALID_AMOUNT', 400], ['INVALID_CURRENCY', 400], ['STATUS_NOT_MANUAL_SETTABLE', 400],
    ['LINE_ALREADY_ALLOCATED', 409], ['NOT_FOUND', 404], ['INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH', 409],
    ['INVOICE_CUSTOMER_MISMATCH', 409], ['AMOUNT_BELOW_ALLOCATED', 409], ['HAS_ALLOCATIONS', 409],
    ['SOURCE_CLAIM_CONFLICT', 409], ['LC_GATE_BLOCKED', 403], ['LC_EXCEPTION_CHECK_FAILED', 500],
    ['REVIEW_STALE', 409], ['REVIEW_REQUIRED', 409], ['COVERAGE_CONFLICT', 409],
    ['INVALID_BILLING_SOURCE', 409], ['HANDOFF_CONFLICT', 409],
  ] as const)('preserves declared Invoice %s HTTP %i and its deliberate public copy', async (code, status) => {
    const f = fixture(), message = `已声明的业务拒绝：${code}`;
    const create = vi.spyOn(invoiceMutations, 'createInvoice').mockResolvedValueOnce({ ok: false, error: { code, message } });
    const res = await f.submit();
    expect(res.status).toBe(status); expect(res.body).toEqual({ error: { code, message } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ prisma: f.db, actorId: actor.userId,
      input: expect.objectContaining({ amount: 100, orderId: 'commission-order', sourceId: 'commission-order#1' }) }));
    f.noNativeWrite(true);
  });

  it.each(['CREATE_FAILED', 'UPDATE_FAILED'] as const)('%s stays 500 with safe result-uncertain copy, regardless of downstream raw text', async code => {
    const f = fixture(); vi.spyOn(invoiceMutations, 'createInvoice').mockResolvedValueOnce({ ok: false, error: { code, message: PRIVATE_SQL } });
    const res = await f.submit();
    expect(res.status).toBe(500); expect(res.body).toEqual({ error: { code, message: CREATE_COPY } });
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_SQL); expect(res.body.error.message).not.toMatch(/已回滚|未写入|没有写入/);
    f.noNativeWrite(true);
  });

  it.each([
    { code: 'UNDECLARED_VALIDATION', message: PRIVATE_SQL, statusCode: 400 },
    { code: 'P2002', message: PRIVATE_SQL },
    { code: 'VALIDATION_FAILED', message: PRIVATE_SQL, statusCode: 400 }, // registered elsewhere, outside Invoice's declared family
    { code: 'LINE_ALREADY_ALLOCATED', message: { sql: PRIVATE_SQL } },
    undefined,
  ])('never converts undeclared or malformed Invoice error $code to public 400', async error => {
    const f = fixture(); vi.spyOn(invoiceMutations, 'createInvoice').mockResolvedValueOnce({ ok: false, error } as any);
    const res = await f.submit();
    expect(res.status).toBe(500); expect(res.body).toEqual({ error: { code: 'CREATE_FAILED', message: CREATE_COPY } });
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_SQL); f.noNativeWrite(true);
  });

  it('preserves a deliberate typed Invoice refusal while an unknown thrown SQL exception stays safe 500', async () => {
    const f = fixture(), create = vi.spyOn(invoiceMutations, 'createInvoice');
    create.mockRejectedValueOnce(Object.assign(new Error('发票来源不存在'), { code: 'NOT_FOUND', statusCode: 404 }));
    const refused = await f.submit();
    expect(refused.status).toBe(404); expect(refused.body).toEqual({ error: { code: 'NOT_FOUND', message: '发票来源不存在' } });
    create.mockRejectedValueOnce(Object.assign(new Error(PRIVATE_SQL), { code: 'UNDECLARED_VALIDATION', statusCode: 400 }));
    const unknown = await f.submit();
    expect(unknown.status).toBe(500); expect(unknown.body).toEqual({ error: { code: 'CREATE_FAILED', message: CREATE_COPY } });
    f.noNativeWrite(true);
  });

  it.each(['INVALID_AMOUNT', 'P2010'] as const)('a thrown code-only %s exception is not a declared business refusal', async code => {
    const f = fixture();
    vi.spyOn(invoiceMutations, 'createInvoice').mockRejectedValueOnce(Object.assign(new Error(PRIVATE_SQL), { code }));
    const res = await f.submit();
    expect(res.status).toBe(500); expect(res.body).toEqual({ error: { code: 'CREATE_FAILED', message: CREATE_COPY } });
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_SQL); f.noNativeWrite(true);
  });

  it.each(['no-commission', 'no-intermediary', 'already-invoiced'] as const)('retains the existing %s refusal as 409 without invoking Invoice writes', async variant => {
    const f = fixture();
    if (variant === 'no-commission') f.db.pricingCalculation.findMany.mockResolvedValueOnce([]);
    if (variant === 'no-intermediary') f.db.commissionRule.findMany.mockResolvedValueOnce([{ id: 'commission-rule', rate: 5, intermediaryRelationId: null }]);
    if (variant === 'already-invoiced') f.state.invoices.push({ id: 'existing-invoice', invoiceNumber: 'INV-EXISTING', amount: 100,
      type: 'Payable', currency: 'USD', status: 'Issued', issueDate: '2026-10-01', sourceId: 'commission-order#1', orderId: 'commission-order', deletedAt: null });
    const res = await f.submit();
    expect(res.status).toBe(409); expect(res.body.error.code).toBe(variant === 'no-commission' ? 'NO_COMMISSION'
      : variant === 'no-intermediary' ? 'INTERMEDIARY_UNRESOLVED' : 'ALREADY_INVOICED');
    if (variant === 'no-commission') expect(res.body.error.message).toBe('该订单没有已确认的佣金（定价行未确认 / 佣金率为 0），无需开应付');
    if (variant === 'no-intermediary') expect(res.body.error.message).toContain('请先在佣金规则里补上中间人，再开应付');
    if (variant === 'already-invoiced') expect(res.body.error.message).toBe('该订单的佣金应付已开票（已开 100 USD，共 100），无需重复开票；如需调整请先作废原发票');
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.onDataChange).not.toHaveBeenCalled();
  });

  it('contains readonly query failure inside getOrderCommission and keeps both service and HTTP copy safe', async () => {
    const f = fixture(); f.db.pricingCalculation.findMany.mockRejectedValue(new Error(PRIVATE_SQL));
    expect(await getOrderCommission(f.db, 'commission-order')).toEqual({ ok: false, error: { code: 'COMMISSION_VIEW_FAILED', status: 500, message: READ_COPY } });
    const res = await f.read();
    expect(res.status).toBe(500); expect(res.body).toEqual({ error: { code: 'COMMISSION_VIEW_FAILED', message: READ_COPY } });
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_SQL); f.noNativeWrite();
  });

  it('contains native source-history read failure before any Invoice write', async () => {
    const f = fixture();
    f.db.invoice.findMany.mockImplementation(async (args: any) => { if (!args.orderBy) throw new Error(PRIVATE_SQL); return []; });
    const res = await f.submit();
    expect(res.status).toBe(500); expect(res.body).toEqual({ error: { code: 'CREATE_FAILED', message: CREATE_COPY } });
    f.noNativeWrite();
  });

  it.each(['storage-error', 'source-disappeared'] as const)('native Invoice committed before %s in post-read remains visible, but the command does not report a stale successful balance', async variant => {
    const f = fixture(); f.state.failPostRead = variant === 'storage-error'; f.state.missingPostRead = variant === 'source-disappeared';
    const res = await f.submit();
    expect(res.status).toBe(500); expect(res.body).toEqual({ error: { code: 'CREATE_FAILED', message: CREATE_COPY } });
    expect(res.body).not.toHaveProperty('commission'); expect(res.body.error.message).not.toMatch(/已回滚|未写入|没有写入/);
    expect(f.state.committed).toBe(true); expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.state.invoices).toHaveLength(1); expect(f.state.audits).toHaveLength(1);
    expect(f.state.invoices[0]).toMatchObject({ type: 'Payable', orderId: 'commission-order', sourceId: 'commission-order#1', amount: new Prisma.Decimal(100) });
    expect(f.onDataChange).not.toHaveBeenCalled();
    // Independent retry after storage recovers reads the already-created Invoice;
    // it must refuse duplication rather than reissue under a fresh sequence.
    f.state.failPostRead = false; f.state.missingPostRead = false;
    const retry = await createCommissionPayable(f.db, { orderId: 'commission-order' }, actor.userId);
    expect(retry).toMatchObject({ ok: false, error: { code: 'ALREADY_INVOICED', status: 409 } });
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.state.invoices).toHaveLength(1);
  });
});
