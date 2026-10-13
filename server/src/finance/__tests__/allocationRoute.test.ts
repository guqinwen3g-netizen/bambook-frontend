import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { recalcInvoiceStatus, recalcVoucherStatus, validateAllocationInput } from '../allocationService';

// ============================================================================
// task ERP-P1-payment-allocation-route-foundation: allocationService 纯函数
// ============================================================================

describe('task allocation-foundation: validateAllocationInput（fail closed）', () => {
  it('缺失 invoiceId → MISSING_INVOICE', () => {
    const r = validateAllocationInput({ voucherId: 'V1', appliedAmount: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('MISSING_INVOICE');
  });

  it('缺失 voucherId → MISSING_VOUCHER', () => {
    const r = validateAllocationInput({ invoiceId: 'I1', appliedAmount: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('MISSING_VOUCHER');
  });

  it('缺失 appliedAmount → MISSING_AMOUNT', () => {
    const r = validateAllocationInput({ invoiceId: 'I1', voucherId: 'V1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('MISSING_AMOUNT');
  });

  it('appliedAmount 非数字 → INVALID_AMOUNT', () => {
    const r = validateAllocationInput({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_AMOUNT');
  });

  it('appliedAmount <= 0 → INVALID_AMOUNT', () => {
    expect(validateAllocationInput({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 0 }).error).toBe('INVALID_AMOUNT');
    expect(validateAllocationInput({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: -50 }).error).toBe('INVALID_AMOUNT');
  });

  it('合法输入 → ok', () => {
    expect(validateAllocationInput({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 }).ok).toBe(true);
  });
});

describe('task allocation-foundation: recalcInvoiceStatus（Decimal-safe）', () => {
  function makeTx(allocs: any[], invoice: any) {
    return {
      invoice: { findUnique: vi.fn().mockResolvedValue(invoice) },
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue(allocs) },
    } as any;
  }

  it('totalApplied >= invoice.amount → Paid', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal(100) }, { appliedAmount: new Prisma.Decimal(50) }],
      { id: 'I1', amount: new Prisma.Decimal(150), status: 'Issued' },
    );
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('Paid');
  });

  it('totalApplied > 0 but < amount → PartiallyPaid', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal(50) }],
      { id: 'I1', amount: new Prisma.Decimal(150), status: 'Issued' },
    );
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('PartiallyPaid');
  });

  it('totalApplied == 0 且当前 Paid → 回退 Issued（删除最后一条后回退）', async () => {
    const tx = makeTx([], { id: 'I1', amount: new Prisma.Decimal(150), status: 'Paid' });
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('Issued');
  });

  it('totalApplied == 0 且当前 PartiallyPaid → 回退 Issued', async () => {
    const tx = makeTx([], { id: 'I1', amount: new Prisma.Decimal(150), status: 'PartiallyPaid' });
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('Issued');
  });

  it('totalApplied == 0 且当前 Issued → 保持 Issued（不回退）', async () => {
    const tx = makeTx([], { id: 'I1', amount: new Prisma.Decimal(150), status: 'Issued' });
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('Issued');
  });

  it('invoice 不存在 → Draft', async () => {
    const tx = makeTx([], null);
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('Draft');
  });

  it('Decimal 精度安全（0.1+0.2 不漂移）', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal('0.1') }, { appliedAmount: new Prisma.Decimal('0.2') }],
      { id: 'I1', amount: new Prisma.Decimal('0.3'), status: 'Issued' },
    );
    // 0.1+0.2 = 0.3（Decimal 精确），>= 0.3 → Paid
    expect(await recalcInvoiceStatus(tx, 'I1')).toBe('Paid');
  });
});

describe('task allocation-foundation: recalcVoucherStatus（Decimal-safe）', () => {
  function makeTx(allocs: any[], voucher: any) {
    return {
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue(voucher) },
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue(allocs) },
    } as any;
  }

  it('totalAllocated >= voucherAmount → reconciled + 汇总 totalAllocated', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal(200) }],
      { id: 'V1', amount: new Prisma.Decimal(200) },
    );
    const r = await recalcVoucherStatus(tx, 'V1');
    expect(r.status).toBe('reconciled');
    expect(Number(r.totalAllocated)).toBe(200);
  });

  it('totalAllocated > 0 but < voucherAmount → partially_reconciled', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal(50) }],
      { id: 'V1', amount: new Prisma.Decimal(200) },
    );
    const r = await recalcVoucherStatus(tx, 'V1');
    expect(r.status).toBe('partially_reconciled');
  });

  it('totalAllocated == 0 → unreconciled', async () => {
    const tx = makeTx([], { id: 'V1', amount: new Prisma.Decimal(200) });
    expect((await recalcVoucherStatus(tx, 'V1')).status).toBe('unreconciled');
  });

  it('voucherAmount == 0 → unreconciled（边界）', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal(100) }],
      { id: 'V1', amount: new Prisma.Decimal(0) },
    );
    expect((await recalcVoucherStatus(tx, 'V1')).status).toBe('unreconciled');
  });

  it('voucher 不存在 → unreconciled', async () => {
    const tx = makeTx([], null);
    expect((await recalcVoucherStatus(tx, 'V1')).status).toBe('unreconciled');
  });

  it('多 invoice 分摊 → totalAllocated 汇总（非单笔）', async () => {
    const tx = makeTx(
      [{ appliedAmount: new Prisma.Decimal(100) }, { appliedAmount: new Prisma.Decimal(150) }],
      { id: 'V1', amount: new Prisma.Decimal(300) },
    );
    const r = await recalcVoucherStatus(tx, 'V1');
    expect(Number(r.totalAllocated)).toBe(250); // 100+150 汇总
    expect(r.status).toBe('partially_reconciled'); // 250 < 300
  });
});

// ============================================================================
// route 集成测试（mock prisma + supertest）
// ============================================================================

import express from 'express';
import request from 'supertest';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

function makeAllocApp(opts: { invoice?: any; voucher?: any; existingAlloc?: any; txFail?: boolean; allocsForRecalc?: any[] }) {
  const invoiceFind = vi.fn().mockResolvedValue(opts.invoice === undefined ? { id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(100), status: 'Issued', deletedAt: null, invoiceNumber: 'INV001' } : opts.invoice);
  const voucherFind = vi.fn().mockResolvedValue(opts.voucher === undefined ? { id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(100), status: 'unreconciled', deletedAt: null, voucherNumber: 'V001', invoiceId: null } : opts.voucher);
  let allocation = opts.existingAlloc ?? null;
  const allocFind = vi.fn(async () => allocation);
  const allocUpsert = vi.fn().mockImplementation(async ({ create, update }: any) => { allocation = allocation ? { ...allocation, ...update } : { ...create }; return allocation; });
  const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, invoiceNumber: 'INV001' }));
  const voucherUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, voucherNumber: 'V001' }));
  const auditCreate = vi.fn().mockResolvedValue({});
  const allocFindMany = vi.fn(async ({ where }: any = {}) => (opts.allocsForRecalc ?? (allocation ? [allocation] : [])).filter(row => (!where?.invoiceId || row.invoiceId === where.invoiceId) && (!where?.voucherId || row.voucherId === where.voucherId)));

  const tx = {
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
    invoice: { findUnique: invoiceFind, update: invoiceUpdate },
    paymentVoucher: { findUnique: voucherFind, update: voucherUpdate },
    invoiceAllocation: { findUnique: allocFind, upsert: allocUpsert, findMany: allocFindMany, delete: vi.fn().mockResolvedValue({}), update: vi.fn() },
    auditLog: { create: auditCreate },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  };
  const $transaction = vi.fn(async (fn: any) => {
    if (opts.txFail) throw new Error('TX_FAIL');
    return fn(tx);
  });

  const prisma = { $transaction, invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]) } } as any;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
  return { app, tx, $transaction, auditCreate, invoiceUpdate, voucherUpdate, allocUpsert, allocFind };
}

describe('task allocation-foundation: POST /allocations 集成', () => {
  it('非法 amount → 400，不写 DB/audit', async () => {
    const { app, auditCreate, allocUpsert } = makeAllocApp({});
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: -10 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
    expect(allocUpsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('invoice 不存在 → 404 INVOICE_NOT_FOUND', async () => {
    const { app } = makeAllocApp({ invoice: null });
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'IX', voucherId: 'V1', appliedAmount: 50 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
  });

  it('voucher 不存在 → 404 VOUCHER_NOT_FOUND', async () => {
    const { app } = makeAllocApp({ voucher: null });
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'VX', appliedAmount: 50 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('VOUCHER_NOT_FOUND');
  });

  it('成功创建 → 201 + invoice/voucher status 重算 + AuditLog', async () => {
    const { app, auditCreate, invoiceUpdate, voucherUpdate } = makeAllocApp({});
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(201);
    expect(res.body.newInvoiceStatus).toBe('Paid');
    expect(res.body.newVoucherStatus).toBe('reconciled');
    expect(invoiceUpdate).toHaveBeenCalled();
    expect(voucherUpdate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('事务失败（audit/sync 失败）→ 500，不伪成功', async () => {
    const { app } = makeAllocApp({ txFail: true });
    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
  });
});

describe('task allocation-foundation: DELETE /allocations 反向重算', () => {
  it('删除后 status 反向重算（invoice 回 PartiallyPaid/原状）', async () => {
    const invoiceFind = vi.fn().mockResolvedValue({ id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(100), status: 'Paid' });
    const voucherFind = vi.fn().mockResolvedValue({ id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(100), status: 'reconciled' });
    const allocFind = vi.fn().mockResolvedValue({ id: 'ALLOC__I1__V1', invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal(100) });
    const allocDelete = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    // 删除后 findMany 返回空 → totalApplied=0 → recalc 返回 null/原状
    const allocFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
      creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
      creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
      invoice: { findUnique: invoiceFind, update: vi.fn().mockResolvedValue({}) },
      paymentVoucher: { findUnique: voucherFind, update: vi.fn().mockResolvedValue({}) },
      invoiceAllocation: { findUnique: allocFind, delete: allocDelete, findMany: allocFindMany },
      auditLog: { create: auditCreate },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(allocDelete).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('allocation 不存在 → 404', async () => {
    const app = express();
    app.use(express.json());
    const tx = {
      invoiceAllocation: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).delete('/api/v1/finance/allocations/NOPE').set(authHeader());
    expect(res.status).toBe(404);
  });
});

describe('task allocation-foundation: GET /allocations list/query', () => {
  it('按 invoiceId 过滤', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'A1', invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 }]);
    const prisma = { $transaction: vi.fn(), invoiceAllocation: { findMany } } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).get('/api/v1/finance/allocations?invoiceId=I1').set(authHeader());
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { invoiceId: 'I1' } }));
  });
});


// ============================================================================
// task 阻断修复验证：删除回退 / 汇总 appliedAmount / sync 覆盖
// ============================================================================

describe('task allocation-foundation 阻断修复: 删除最后一条 invoice status 回退', () => {
  it('DELETE 后 invoice 从 Paid 回退 Issued（recalc totalApplied==0）', async () => {
    // DELETE 后 findMany 返回空 → recalc totalApplied=0，invoice 当前 Paid → 回退 Issued
    const invoiceFind = vi.fn().mockResolvedValue({ id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(100), status: 'Paid' });
    const voucherFind = vi.fn().mockResolvedValue({ id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(100), status: 'reconciled', voucherNumber: 'V001', invoiceId: 'I1' });
    const allocFind = vi.fn().mockResolvedValue({ id: 'ALLOC__I1__V1', invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal(100) });
    const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, invoiceNumber: 'INV001' }));
    const voucherUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, voucherNumber: 'V001' }));
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
      creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
      creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
      invoice: { findUnique: invoiceFind, update: invoiceUpdate },
      paymentVoucher: { findUnique: voucherFind, update: voucherUpdate },
      invoiceAllocation: { findUnique: allocFind, delete: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: auditCreate },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(200);
    // invoice 回退 Issued
    expect(res.body.newInvoiceStatus).toBe('Issued');
    // invoice.update 被调用（不因 null 跳过）
    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('task allocation-foundation 阻断修复: voucher appliedAmount 汇总（非单笔）', () => {
  it('POST 后 voucher.appliedAmount = 该 voucher 所有 allocation 汇总', async () => {
    // mock: findMany 返回 2 笔 allocation（I0 的 100 + I1 新增 150 = 250，均属于 V1），voucher amount=300, invoice amount=300
    const invoiceFind = vi.fn().mockResolvedValue({ id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(300), status: 'Issued', deletedAt: null, invoiceNumber: 'INV001' });
    const voucherFind = vi.fn().mockResolvedValue({ id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(300), status: 'unreconciled', deletedAt: null, voucherNumber: 'V001', invoiceId: null });
    const allocations = [{ invoiceId: 'I0', voucherId: 'V1', appliedAmount: new Prisma.Decimal(100) }];
    const allocFindMany = vi.fn(async ({ where }: any) => allocations.filter(row =>
      (!where?.invoiceId || row.invoiceId === where.invoiceId) && (!where?.voucherId || row.voucherId === where.voucherId)));
    let voucherUpdateData: any = null;
    const voucherUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => { voucherUpdateData = data; return { id: where.id, ...data, voucherNumber: 'V001' }; });
    const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, invoiceNumber: 'INV001' }));

    const tx = {
      $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
      creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
      creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
      invoice: { findUnique: invoiceFind, update: invoiceUpdate },
      paymentVoucher: { findUnique: voucherFind, update: voucherUpdate },
      invoiceAllocation: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockImplementation(async ({ create }: any) => { allocations.push(create); return create; }), findMany: allocFindMany },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)), invoiceAllocation: { findMany: vi.fn() } } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 150 });
    expect(res.status).toBe(201);
    // voucher.appliedAmount 应是汇总 250（100+150），非单笔 150
    expect(new Prisma.Decimal(voucherUpdateData.appliedAmount).toString()).toBe('250');
    expect(res.body.newVoucherStatus).toBe('partially_reconciled');
  });
});

describe('task allocation-foundation 阻断修复: allocation create/update/delete 后 EntityLink sync', () => {
  it('POST allocation 触发 syncInvoiceReferences + syncPaymentVoucherReferences（传完整对象）', async () => {
    const entityRefUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const invoiceFind = vi.fn().mockResolvedValue({ id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(100), status: 'Issued', deletedAt: null, invoiceNumber: 'INV001', orderId: 'O1' });
    const voucherFind = vi.fn().mockResolvedValue({ id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(100), status: 'unreconciled', deletedAt: null, voucherNumber: 'V001', invoiceId: null });
    const tx = {
      $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
      creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
      creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
      invoice: { findUnique: invoiceFind, update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, invoiceNumber: 'INV001', orderId: 'O1' })) },
      paymentVoucher: { findUnique: voucherFind, update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, voucherNumber: 'V001', invoiceId: 'I1' })) },
      invoiceAllocation: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockImplementation(async ({ create }: any) => create), findMany: vi.fn().mockResolvedValue([{ invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal(100) }]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: entityRefUpsert },
      entityLink: { upsert: entityLinkUpsert, findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)), invoiceAllocation: { findMany: vi.fn() } } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).post('/api/v1/finance/allocations').set(authHeader()).send({ invoiceId: 'I1', voucherId: 'V1', appliedAmount: 100 });
    expect(res.status).toBe(201);
    // sync 被调用（entityReference/entityLink upsert）
    expect(entityRefUpsert).toHaveBeenCalled();
    expect(entityLinkUpsert).toHaveBeenCalled();
  });

  it('DELETE allocation 触发 sync invoice + voucher（EntityLink 随事实变化）', async () => {
    const entityRefUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
      creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
      creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
      invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(100), status: 'Paid' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, invoiceNumber: 'INV001' })) },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue({ id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(100), status: 'reconciled', voucherNumber: 'V001', invoiceId: 'I1' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, voucherNumber: 'V001', invoiceId: 'I1' })) },
      invoiceAllocation: { findUnique: vi.fn().mockResolvedValue({ id: 'ALLOC__I1__V1', invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal(100) }), delete: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: entityRefUpsert },
      entityLink: { upsert: entityLinkUpsert, findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(200);
    // sync 被调用
    expect(entityRefUpsert).toHaveBeenCalled();
    expect(entityLinkUpsert).toHaveBeenCalled();
  });
});


// ============================================================================
// task 阻断3 fix: allocation-aware EntityLink sync（syncAllocationVoucherLinks）
// ============================================================================
import { syncAllocationVoucherLinks } from '../allocationService';

describe('task allocation-foundation 阻断3 fix: syncAllocationVoucherLinks（allocation-aware）', () => {
  function makeSyncTx(allocs: any[], existingLinks: any[] = []) {
    const entityRefUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const entityLinkFindMany = vi.fn().mockResolvedValue(existingLinks);
    const entityLinkUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue(allocs) },
      entityReference: { upsert: entityRefUpsert },
      entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
    } as any;
    return { tx, entityRefUpsert, entityLinkUpsert, entityLinkFindMany, entityLinkUpdate };
  }

  it('单 allocation → upsert 1 个 active settlesInvoice link', async () => {
    const { tx, entityLinkUpsert } = makeSyncTx([{ invoiceId: 'I1', appliedAmount: new Prisma.Decimal(100) }]);
    await syncAllocationVoucherLinks(tx, 'V1', { source: 'test' });
    // upsert 1 link for I1
    const linkCalls = entityLinkUpsert.mock.calls;
    expect(linkCalls.length).toBe(1);
    expect(linkCalls[0][0].where.id).toContain('settlesInvoice');
    expect(linkCalls[0][0].create.toId).toBe('I1');
    expect(linkCalls[0][0].create.linkKind).toBe('settlesInvoice');
  });

  it('split voucher（2 张 invoice）→ upsert 2 个 active settlesInvoice link', async () => {
    const { tx, entityLinkUpsert } = makeSyncTx([
      { invoiceId: 'I1', appliedAmount: new Prisma.Decimal(100) },
      { invoiceId: 'I2', appliedAmount: new Prisma.Decimal(150) },
    ]);
    await syncAllocationVoucherLinks(tx, 'V1', { source: 'test' });
    expect(entityLinkUpsert.mock.calls.length).toBe(2);
    const toIds = entityLinkUpsert.mock.calls.map((c: any) => c[0].create.toId);
    expect(toIds).toEqual(expect.arrayContaining(['I1', 'I2']));
  });

  it('删除其中一张 invoice allocation → 旧 link 置 inactive（目标集合准确）', async () => {
    // 当前只剩 I1 allocation，但已有 I2 的 active link → I2 link 应置 inactive
    const { tx, entityLinkUpdate } = makeSyncTx(
      [{ invoiceId: 'I1', appliedAmount: new Prisma.Decimal(100) }],
      [
        { id: 'LINK__V1__settlesInvoice__I1', toId: 'I1', status: 'active' },
        { id: 'LINK__V1__settlesInvoice__I2', toId: 'I2', status: 'active' },
      ],
    );
    await syncAllocationVoucherLinks(tx, 'V1', { source: 'test' });
    // I2 link 应被 update 为 inactive
    const updateCalls = entityLinkUpdate.mock.calls;
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0].where.id).toContain('I2');
    expect(updateCalls[0][0].data.status).toBe('inactive');
  });

  it('删除最后一张 allocation（空）→ 所有旧 settlesInvoice link 置 inactive', async () => {
    const { tx, entityLinkUpdate } = makeSyncTx(
      [],
      [
        { id: 'LINK__V1__settlesInvoice__I1', toId: 'I1', status: 'active' },
        { id: 'LINK__V1__settlesInvoice__I2', toId: 'I2', status: 'active' },
      ],
    );
    await syncAllocationVoucherLinks(tx, 'V1', { source: 'test' });
    // 两个 link 都应置 inactive
    expect(entityLinkUpdate.mock.calls.length).toBe(2);
  });

  it('已 inactive 的 link 不重复 update', async () => {
    const { tx, entityLinkUpdate } = makeSyncTx(
      [{ invoiceId: 'I1', appliedAmount: new Prisma.Decimal(100) }],
      [
        { id: 'LINK__V1__settlesInvoice__I1', toId: 'I1', status: 'active' },
        { id: 'LINK__V1__settlesInvoice__I2', toId: 'I2', status: 'inactive' }, // 已 inactive
      ],
    );
    await syncAllocationVoucherLinks(tx, 'V1', { source: 'test' });
    // 只有 I2 需要 update？不——I2 已 inactive，不重复 update；I1 还 active，upsert 即可
    // 实际：I2 已 inactive，跳过 update
    expect(entityLinkUpdate.mock.calls.length).toBe(0);
  });

  it('route DELETE allocation 触发 syncAllocationVoucherLinks（停用旧 link）', async () => {
    const entityLinkFindMany = vi.fn().mockResolvedValue([
      { id: 'LINK__V1__settlesInvoice__I1', toId: 'I1', status: 'active' },
    ]);
    const entityLinkUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
      creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offset facts.
      creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt voucher, no cash-refund linkage.
      invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'I1', type: 'Receivable', currency: 'USD', amount: new Prisma.Decimal(100), status: 'Paid' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, invoiceNumber: 'INV001' })) },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue({ id: 'V1', type: 'Receipt', currency: 'USD', amount: new Prisma.Decimal(100), status: 'reconciled', voucherNumber: 'V001', invoiceId: 'I1' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, voucherNumber: 'V001', invoiceId: 'I1' })) },
      invoiceAllocation: { findUnique: vi.fn().mockResolvedValue({ id: 'ALLOC__I1__V1', invoiceId: 'I1', voucherId: 'V1', appliedAmount: new Prisma.Decimal(100) }), delete: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: entityLinkFindMany, update: entityLinkUpdate },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).delete('/api/v1/finance/allocations/ALLOC__I1__V1').set(authHeader());
    expect(res.status).toBe(200);
    // syncAllocationVoucherLinks 触发：I1 link（删除后 allocation 空）应置 inactive
    expect(entityLinkUpdate).toHaveBeenCalled();
    expect(entityLinkFindMany).toHaveBeenCalled();
  });
});
