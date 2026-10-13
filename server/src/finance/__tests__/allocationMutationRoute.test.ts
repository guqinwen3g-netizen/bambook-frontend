import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

function makeApp(opts: { existing?: any; invoice?: any; voucher?: any; syncFail?: boolean; auditFail?: boolean; onDataChange?: any } = {}) {
  const existing = opts.hasOwnProperty('existing') ? opts.existing : { id: 'ALLOC__I1__V1', invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal('100'), appliedDate: '2026-07-02', createdAt: BigInt(1), updatedAt: BigInt(1) };
  const invoice = opts.hasOwnProperty('invoice') ? opts.invoice : { id: 'I1', type: 'Receivable', currency: 'USD', status: 'PartiallyPaid', amount: new Prisma.Decimal('1000'), deletedAt: null };
  const voucher = opts.hasOwnProperty('voucher') ? opts.voucher : { id: 'V1', type: 'Receipt', currency: 'USD', status: 'partially_reconciled', amount: new Prisma.Decimal('1000'), appliedAmount: new Prisma.Decimal('100'), deletedAt: null };
  const allocations = existing ? [{ ...existing }] : [];
  const invoiceAllocationUpsert = vi.fn().mockImplementation(async ({ where, create, update }: any) => {
    const index = allocations.findIndex(row => row.invoiceId === where.invoiceId_voucherId.invoiceId && row.voucherId === where.invoiceId_voucherId.voucherId);
    if (index < 0) { allocations.push({ ...create }); return allocations.at(-1); }
    allocations[index] = { ...allocations[index], ...update }; return allocations[index];
  });
  const invoiceAllocationUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => {
    const index = allocations.findIndex(row => row.id === where.id);
    allocations[index] = { ...allocations[index], ...data }; return allocations[index];
  });
  const invoiceAllocationFindUnique = vi.fn().mockImplementation(async ({ where }: any) => allocations.find(row => row.id === where.id) ?? null);
  const invoiceAllocationDelete = vi.fn().mockImplementation(async ({ where }: any) => {
    const index = allocations.findIndex(row => row.id === where.id); return allocations.splice(index, 1)[0];
  });
  const invoiceAllocationFindMany = vi.fn().mockImplementation(async ({ where }: any = {}) => allocations.filter(row =>
    (!where?.invoiceId || row.invoiceId === where.invoiceId) && (!where?.voucherId || row.voucherId === where.voucherId)));
  const invoiceFindUnique = vi.fn().mockResolvedValue(invoice);
  const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...invoice, ...data, id: where.id }));
  const voucherFindUnique = vi.fn().mockResolvedValue(voucher);
  const voucherUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...voucher, ...data, id: where.id }));
  const entityReferenceUpsert = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const entityLinkFindMany = vi.fn().mockResolvedValue([]);
  const entityLinkUpdate = vi.fn().mockResolvedValue({});
  const entityRefFindMany = vi.fn().mockResolvedValue([]);
  const entityRefUpdate = vi.fn().mockResolvedValue({});
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({ id: 'AL-1' });
  const tx = {
    // Actual current financial identity for the common transport/source gate;
    // the JWT remains an initiating credential, not stored authorization.
    userAccount: { findUnique: vi.fn(async ({ where }: any) => ({ id: where.id, status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ roleId: 'role-finance', departmentId: null, role: { id: 'role-finance', permissions: ['invoices:read', 'invoices:reconcile'].map(scope => ({ permission: { scope } })) } }] })) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No credit-note offset facts in this fixture.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt-allocation fixture.
    invoice: { findUnique: invoiceFindUnique, findFirst: invoiceFindUnique, update: invoiceUpdate },
    paymentVoucher: { findUnique: voucherFindUnique, findFirst: voucherFindUnique, update: voucherUpdate },
    invoiceAllocation: { findUnique: invoiceAllocationFindUnique, upsert: invoiceAllocationUpsert, update: invoiceAllocationUpdate, delete: invoiceAllocationDelete, findMany: invoiceAllocationFindMany },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityReferenceUpsert, findMany: entityRefFindMany, update: entityRefUpdate },
    entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
  } as any;
  tx.userAccount.findFirst = tx.userAccount.findUnique;
  const prisma = {
    invoice: { findUnique: invoiceFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    paymentVoucher: { findUnique: voucherFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  const onDataChange = opts.onDataChange || vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, prisma, tx, invoiceAllocationUpsert, invoiceAllocationUpdate, invoiceAllocationDelete, invoiceAllocationFindUnique, invoiceUpdate, voucherUpdate, auditCreate, entityReferenceUpsert, entityLinkUpsert, onDataChange };
}

describe('allocationMutationService route POST /allocations', () => {
  beforeEach(() => vi.clearAllMocks());
  it('create success → allocation upsert + recalc/sync/audit + onDataChange + real auditId', async () => {
    const { app, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(201);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const auditData = auditCreate.mock.calls[0][0].data;
    expect(res.body.auditId).toBe(auditData.id);
    expect(auditData.id).toMatch(/^alog_/);
  });

  it('create high-precision decimal string not truncated', async () => {
    const { app } = makeApp({
      invoice: { id: 'I1', type: 'Receivable', currency: 'USD', status: 'PartiallyPaid', amount: new Prisma.Decimal('999999999999999.9999'), deletedAt: null },
      voucher: { id: 'V1', type: 'Receipt', currency: 'USD', status: 'partially_reconciled', amount: new Prisma.Decimal('999999999999999.9999'), appliedAmount: new Prisma.Decimal('100'), deletedAt: null },
    });
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: '123456789012345.1234' });
    expect(res.status).toBe(201);
    expect(res.body.allocation.appliedAmount).toBe('123456789012345.1234');
  });
  it('missing invoice → 400 MISSING_INPUT before tx', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
  it('invalid amount → 400 INVALID_AMOUNT before tx', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 0 });
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('missing invoice entity → 404 INVOICE_NOT_FOUND', async () => {
    const { app } = makeApp({ invoice: null });
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
  it('sync reject → 500 CREATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('allocationMutationService route PATCH /allocations/:id', () => {
  beforeEach(() => vi.clearAllMocks());
  it('update success → allocation update + invoice/voucher recalc + sync + audit', async () => {
    const { app, invoiceAllocationUpdate, invoiceUpdate, voucherUpdate, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: 250 });
    expect(res.status).toBe(200);
    expect(invoiceAllocationUpdate).toHaveBeenCalledTimes(1);
    expect(invoiceUpdate).toHaveBeenCalled();
    expect(voucherUpdate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const auditData = auditCreate.mock.calls[0][0].data;
    expect(res.body.auditId).toBe(auditData.id);
    expect(auditData.id).toMatch(/^alog_/);
  });

  it('update high-precision decimal string written as Prisma.Decimal', async () => {
    const { app, invoiceAllocationUpdate } = makeApp({
      invoice: { id: 'I1', type: 'Receivable', currency: 'USD', status: 'PartiallyPaid', amount: new Prisma.Decimal('100000000'), deletedAt: null },
      voucher: { id: 'V1', type: 'Receipt', currency: 'USD', status: 'partially_reconciled', amount: new Prisma.Decimal('100000000'), appliedAmount: new Prisma.Decimal('100'), deletedAt: null },
    });
    const res = await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: '99999999.9999' });
    expect(res.status).toBe(200);
    expect(invoiceAllocationUpdate.mock.calls[0][0].data.appliedAmount).toBeInstanceOf(Prisma.Decimal);
    expect(res.body.allocation.appliedAmount).toBe('99999999.9999');
  });
  it('PATCH cannot consume another receipt allocation remainder', async () => {
    const { app, tx, invoiceAllocationUpdate, auditCreate, onDataChange } = makeApp();
    tx.invoiceAllocation.findMany.mockImplementation(async ({ where }: any) => where?.invoiceId
      ? [{ invoiceId: 'I1', voucherId: 'OTHER_RECEIPT', appliedAmount: new Prisma.Decimal('900') }]
      : [{ invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal('100') }]);
    const res = await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: '100.0001' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_INVOICE_REMAINING');
    expect(invoiceAllocationUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
  it('invalid amount → 400 INVALID_AMOUNT before tx', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: -5 });
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('not found → 404 NOT_FOUND', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ existing: null });
    const res = await request(app).patch('/api/v1/finance/allocations/NOPE').set(authHeader()).send({ appliedAmount: 50 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
  it('sync reject → 500 UPDATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: 50 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('allocationMutationService route DELETE /allocations/:id', () => {
  beforeEach(() => vi.clearAllMocks());
  it('delete success → hard delete + recalc + sync + audit + onDataChange', async () => {
    const { app, invoiceAllocationDelete, auditCreate, onDataChange } = makeApp();
    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(200);
    expect(invoiceAllocationDelete).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });
  it('not found → 404 NOT_FOUND', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ existing: null });
    const res = await request(app).delete('/api/v1/finance/allocations/NOPE').set(authHeader());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });
  it('audit reject → 500 DELETE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DELETE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('allocationMutationService route→service 契约', () => {
  beforeEach(() => vi.clearAllMocks());
  it('POST/PATCH/DELETE 各触发 service 内 transaction 一次', async () => {
    const { app, prisma } = makeApp();
    await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: 50 });
    await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});

describe('syncAllocationVoucherLinks Decimal-safe snapshot', () => {
  it('high-precision allocation snapshot.appliedAmount not Number-truncated', async () => {
    const { syncAllocationVoucherLinks } = await import('../../finance/allocationService');
    const entityReferenceUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const entityLinkFindMany = vi.fn().mockResolvedValue([]);
    const entityLinkUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue([{ invoiceId: 'I1', appliedAmount: new Prisma.Decimal('123456789012345.1234') }]) },
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
    } as any;
    await syncAllocationVoucherLinks(tx, 'V1', { source: 'test' });
    const createData = entityReferenceUpsert.mock.calls[0][0].create;
    expect(createData.snapshot.appliedAmount).toBe('123456789012345.1234');
  });
});

// ============================================================================
// Phase 2 · 2.2: route allocation 事务并发一致性——Serializable 隔离 + P2034 → 409 CONFLICT
// ============================================================================

describe('task 2.2: route allocation 并发一致性（Serializable + P2034 → 409）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /allocations $transaction 以 Serializable 隔离级执行', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(201);
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  it('POST /allocations P2034 序列化冲突 → 409 CONFLICT（可安全重试，不泛化 500）', async () => {
    const { app, prisma } = makeApp();
    (prisma.$transaction as any).mockRejectedValueOnce(Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' }));
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // ★ 口径来自判据而非现值：并发冲突的文案必须让财务知道「有没有留下记录」+「下一步做什么」，
    //   且不得把 Prisma/P2034 原文带上屏（B30：以前这句是 `…retry the operation (<原文>)`）。
    expect(res.body.error.message).toContain('回滚');
    expect(res.body.error.message).toContain('重新提交');
    expect(JSON.stringify(res.body)).not.toContain('write conflict');
    expect(JSON.stringify(res.body)).not.toContain('deadlock');
    expect(JSON.stringify(res.body)).not.toContain('P2034');
  });

  it('PATCH /allocations/:id P2034 → 409 CONFLICT', async () => {
    const { app, prisma } = makeApp();
    (prisma.$transaction as any).mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }));
    const res = await request(app).patch('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader()).send({ appliedAmount: 200 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('DELETE /allocations/:id P2034 → 409 CONFLICT', async () => {
    const { app, prisma } = makeApp();
    (prisma.$transaction as any).mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }));
    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('非 P2034 事务失败仍归 500 CREATE_FAILED（不错误鼓励重试）', async () => {
    const { app, prisma } = makeApp();
    (prisma.$transaction as any).mockRejectedValueOnce(new Error('DB_CONNECTION_LOST'));
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
  });
});
