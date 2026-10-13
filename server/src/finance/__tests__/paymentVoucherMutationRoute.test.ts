import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

function makeApp(opts: {
  voucher?: any;
  auditFail?: boolean;
  syncFail?: boolean;
  onDataChange?: any;
} = {}) {
  const voucher = opts.hasOwnProperty('voucher') ? opts.voucher : {
    id: 'PAY__1', voucherNumber: 'PV-001', type: 'Receipt', amount: new Prisma.Decimal('100.0000'), currency: 'USD',
    paymentDate: '2026-07-02', paymentMethod: 'TT', status: 'unreconciled', bankFee: new Prisma.Decimal('0'),
    orderId: null, invoiceId: null, customerRelationId: null, customerName: null, appliedAmount: null, deletedAt: null,
  };
  const paymentVoucherCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: 'PAY__NEW' }));
  const paymentVoucherUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...(voucher || {}), ...data, id: where.id }));
  const paymentVoucherFindUnique = vi.fn().mockResolvedValue(voucher);
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({ id: 'AL-1' });
  const entityReferenceUpsert = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary receipt-voucher update fixture.
    invoice: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    paymentVoucher: { create: paymentVoucherCreate, update: paymentVoucherUpdate, findUnique: paymentVoucherFindUnique },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityReferenceUpsert },
    entityLink: { upsert: entityLinkUpsert, findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  } as any;
  const prisma = {
    invoice: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: paymentVoucherFindUnique },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  const onDataChange = opts.onDataChange || vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, prisma, tx, paymentVoucherCreate, paymentVoucherUpdate, paymentVoucherFindUnique, auditCreate, entityReferenceUpsert, entityLinkUpsert, onDataChange };
}

describe('paymentVoucherMutationService route POST /vouchers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create success → create + sync + audit 同事务，onDataChange 成功后触发', async () => {
    const { app, paymentVoucherCreate, entityReferenceUpsert, entityLinkUpsert, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-001', type: 'Receipt', amount: '123.4567', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
      invoiceId: 'INV-1', orderId: 'ORD-1', customerRelationId: 'REL-1', customerName: 'Acme', bankFee: '1.0000',
    });
    expect(res.status).toBe(201);
    expect(paymentVoucherCreate).toHaveBeenCalledTimes(1);
    const createData = paymentVoucherCreate.mock.calls[0][0].data;
    expect(createData.amount).toBeInstanceOf(Prisma.Decimal);
    expect(createData.amount.toString()).toBe('123.4567');
    expect(createData.bankFee).toBeInstanceOf(Prisma.Decimal);
    expect(createData.status).toBe('unreconciled');
    expect(entityReferenceUpsert).toHaveBeenCalled();
    expect(entityLinkUpsert).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('空体/必填字段缺失 → 400 VALIDATION_ERROR（不再坠事务撞 P2012 变 500），不进 transaction/audit/onDataChange', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('type');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('缺单一必填字段（paymentMethod）→ 400 VALIDATION_ERROR', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      type: 'Receipt', amount: '10', currency: 'USD',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('paymentMethod');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('非法 status → 400 INVALID_STATUS，不进 transaction/audit/onDataChange', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-001', type: 'Receipt', amount: '10', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT', status: 'paid',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('非法 amount → 400 INVALID_AMOUNT，不进 transaction/audit/onDataChange', async () => {
    const { app, prisma, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-001', type: 'Receipt', amount: 'abc', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('sync reject → 500 CREATE_FAILED，audit/onDataChange 不触发', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-001', type: 'Receipt', amount: '10', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT', invoiceId: 'INV-1',
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → 500 CREATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-001', type: 'Receipt', amount: '10', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('paymentVoucherMutationService route PATCH /vouchers/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update success → find + update + sync + audit 同事务，onDataChange 成功后触发', async () => {
    const { app, paymentVoucherUpdate, auditCreate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ amount: '99.9900', bankFee: '2.5000' });
    expect(res.status).toBe(200);
    expect(paymentVoucherUpdate).toHaveBeenCalledTimes(1);
    const data = paymentVoucherUpdate.mock.calls[0][0].data;
    expect(data.amount).toBeInstanceOf(Prisma.Decimal);
    expect(data.bankFee).toBeInstanceOf(Prisma.Decimal);
    expect(data.status).toBeUndefined(); // status 不在 PATCH 字段白名单内
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('not found/deleted → 404 NOT_FOUND', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ voucher: { id: 'PAY__1', deletedAt: BigInt(1) } });
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ amount: '10' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('status 不可手动 PATCH → 400 STATUS_NOT_MANUAL_SETTABLE（仅 allocation 可设），不进 transaction', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ status: 'partially_reconciled' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STATUS_NOT_MANUAL_SETTABLE');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('非法 bankFee → 400 INVALID_AMOUNT，不进 transaction', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ bankFee: 'Infinity' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('sync reject → 500 UPDATE_FAILED，audit/onDataChange 不触发', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ invoiceId: 'INV-1' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_FAILED');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → 500 UPDATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ amount: '10' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('paymentVoucherMutationService route→service 契约', () => {
  it('POST/PATCH 只触发 service 内 $transaction 各一次', async () => {
    const { app, prisma } = makeApp();
    await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({ voucherNumber: 'PV-001', type: 'Receipt', amount: '10', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT' });
    await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ amount: '11' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────────
// M1·D7-③ feeBearer（银行手续费承担方 OUR/BEN/SHA，KB-1.7）
//   列已落库（迁移 20260920010000），但若没有写入路径与校验 ⇒ 语义悬空（与 C2 同型误导）。
//   口径：null = 未标注（不猜承担方）；传入则必须是 OUR/BEN/SHA，枚举外一律拒绝（报错优于算错）。
// ────────────────────────────────────────────────────────────────
describe('feeBearer（D7-③）写入与校验', () => {
  it('POST 传 SHA → 落库为 SHA（大写归一）', async () => {
    const { app, paymentVoucherCreate } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-FB-1', type: 'Receipt', amount: '100', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
      bankFee: '10', feeBearer: 'sha',
    });
    expect(res.status).toBe(201);
    expect(paymentVoucherCreate.mock.calls[0][0].data.feeBearer).toBe('SHA');
  });

  it('POST 传枚举外值 FOO → 400 INVALID_FEE_BEARER，不进事务', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-FB-2', type: 'Receipt', amount: '100', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
      feeBearer: 'FOO',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FEE_BEARER');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('POST 不传 → 保持未标注（null），不猜默认值', async () => {
    const { app, paymentVoucherCreate } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-FB-3', type: 'Receipt', amount: '100', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
    });
    expect(res.status).toBe(201);
    expect(paymentVoucherCreate.mock.calls[0][0].data.feeBearer).toBeUndefined();
  });

  it('PATCH 传 OUR → 允许；传 BENEFICIARY 等枚举外值 → 400', async () => {
    const { app, paymentVoucherUpdate } = makeApp();
    const ok = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ feeBearer: 'OUR' });
    expect(ok.status).toBe(200);
    expect(paymentVoucherUpdate.mock.calls[0][0].data.feeBearer).toBe('OUR');

    const bad = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ feeBearer: 'BENEFICIARY' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_FEE_BEARER');
  });

  // 前端「清空下拉框」提交的是空串。若不归一，库里会同时存在 '' 与 null 两种「未标注」写法 ⇒ 分组键漂移。
  it('POST 传空串 → 归一为 null（不得落库空串）', async () => {
    const { app, paymentVoucherCreate } = makeApp();
    const res = await request(app).post('/api/v1/finance/vouchers').set(authHeader()).send({
      voucherNumber: 'PV-FB-4', type: 'Receipt', amount: '100', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT',
      feeBearer: '',
    });
    expect(res.status).toBe(201);
    expect(paymentVoucherCreate.mock.calls[0][0].data.feeBearer).toBeNull();
  });

  it('PATCH 传空串 → 清回未标注（null），不是空串', async () => {
    const { app, paymentVoucherUpdate } = makeApp();
    const res = await request(app).patch('/api/v1/finance/vouchers/PAY__1').set(authHeader()).send({ feeBearer: '' });
    expect(res.status).toBe(200);
    expect(paymentVoucherUpdate.mock.calls[0][0].data.feeBearer).toBeNull();
  });
});
