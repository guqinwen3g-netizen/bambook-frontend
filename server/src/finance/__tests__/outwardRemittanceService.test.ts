/**
 * 阶段 C6 — outwardRemittanceService 单测
 * 覆盖：createOutwardRemittance 校验链（fail closed）/ cnyAmount 服务端计算 / 分次付汇与超付阻断 /
 *       deleteOutwardRemittance 软删回滚 / getVoucherRemittanceSummary / listOutwardRemittances
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createOutwardRemittance,
  deleteOutwardRemittance,
  getVoucherRemittanceSummary,
  listOutwardRemittances,
} from '../outwardRemittanceService';

// ── mock helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const DISBURSEMENT_USD = {
  id: 'PAY__D1', voucherNumber: 'PAY-20260801-101', type: 'Disbursement',
  amount: dec(5000), currency: 'USD', exchangeRate: dec('7.10'),
  orderId: 'ORD__1', customerRelationId: 'REL__S1', customerName: 'OceanFreight Co',
  paymentDate: '2026-08-01', deletedAt: null,
};

function makeTx(overrides: {
  voucher?: any;
  existingRemittances?: any[];
  createFail?: boolean;
} = {}) {
  const voucher = overrides.voucher === undefined ? DISBURSEMENT_USD : overrides.voucher;
  const remittanceFindMany = vi.fn().mockResolvedValue(overrides.existingRemittances ?? []);
  const remittanceCreate = overrides.createFail
    ? vi.fn().mockRejectedValue(new Error('DB_DOWN'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const tx = {
    paymentVoucher: { findUnique: vi.fn().mockResolvedValue(voucher) },
    outwardRemittance: {
      findMany: remittanceFindMany,
      create: remittanceCreate,
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findUnique: vi.fn(),
    },
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ id: 'R1' }]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ id: 'L1' }]),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  };
  return { tx, remittanceCreate, remittanceFindMany };
}

function makePrisma(tx: any) {
  return { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('C6 createOutwardRemittance 输入校验（fail closed）', () => {
  it('缺 voucherId → INVALID_INPUT', async () => {
    const r = await createOutwardRemittance({ prisma: {} as any, input: { voucherId: '', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('非法 remitDate → INVALID_DATE', async () => {
    const r = await createOutwardRemittance({ prisma: {} as any, input: { voucherId: 'PAY__D1', remitDate: '2026/08/08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DATE');
  });

  it('foreignAmount ≤ 0 → INVALID_AMOUNT', async () => {
    const r = await createOutwardRemittance({ prisma: {} as any, input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: -5, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
  });

  it('客户端传入 cnyAmount → INVALID_INPUT（防篡改）', async () => {
    const r = await createOutwardRemittance({ prisma: {} as any, input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1, cnyAmount: 710 } as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('非法 purpose → INVALID_PURPOSE', async () => {
    const r = await createOutwardRemittance({ prisma: {} as any, input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1, purpose: 'Bribe' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PURPOSE');
  });
});

describe('C6 createOutwardRemittance 凭证校验', () => {
  it('凭证不存在 → VOUCHER_NOT_FOUND', async () => {
    const { tx } = makeTx({ voucher: null });
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__X', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VOUCHER_NOT_FOUND');
  });

  it('Receipt 凭证 → NOT_A_DISBURSEMENT（收款走结汇路径）', async () => {
    const { tx } = makeTx({ voucher: { ...DISBURSEMENT_USD, type: 'Receipt' } });
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_A_DISBURSEMENT');
  });

  it('CNY 凭证 → CNY_VOUCHER_NO_REMITTANCE', async () => {
    const { tx } = makeTx({ voucher: { ...DISBURSEMENT_USD, currency: 'CNY' } });
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CNY_VOUCHER_NO_REMITTANCE');
  });

  it('币种不一致 → CURRENCY_MISMATCH', async () => {
    const { tx } = makeTx();
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 100, currency: 'EUR', fxRate: 7.8 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CURRENCY_MISMATCH');
  });
});

describe('C6 createOutwardRemittance 付汇主流程', () => {
  it('cnyAmount 服务端计算 = round4(foreignAmount × fxRate)，继承凭证 orderId/relationId', async () => {
    const { tx, remittanceCreate } = makeTx();
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 1000, fxRate: 7.12345678, purpose: 'Freight', payeeName: 'Maersk' } });
    expect(r.ok).toBe(true);
    const created = remittanceCreate.mock.calls[0][0].data;
    expect(created.cnyAmount.toString()).toBe('7123.4568');
    expect(created.orderId).toBe('ORD__1');
    expect(created.customerRelationId).toBe('REL__S1');
    expect(created.purpose).toBe('Freight');
    expect(created.remittanceNumber).toMatch(/^OWR-20260808-/);
  });

  it('分次付汇：已有 4000 付汇后，再付 2000 → OVER_REMITTANCE（余额 1000）', async () => {
    const { tx } = makeTx({ existingRemittances: [{ foreignAmount: dec(4000) }] });
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 2000, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OVER_REMITTANCE');
  });

  it('分次付汇：已有 4000 付汇后，再付 1000（恰好满额）→ 成功', async () => {
    const { tx } = makeTx({ existingRemittances: [{ foreignAmount: dec(4000) }] });
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 1000, fxRate: 7.1 } });
    expect(r.ok).toBe(true);
  });

  it('DB 异常 → CREATE_FAILED', async () => {
    const { tx } = makeTx({ createFail: true });
    const r = await createOutwardRemittance({ prisma: makePrisma(tx), input: { voucherId: 'PAY__D1', remitDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CREATE_FAILED');
  });
});

describe('C6 deleteOutwardRemittance 软删回滚', () => {
  it('存在 → 软删成功（deletedAt 写入）', async () => {
    const { tx } = makeTx();
    tx.outwardRemittance.findUnique.mockResolvedValue({ id: 'OWR__1', remittanceNumber: 'OWR-1', voucherId: 'PAY__D1', foreignAmount: dec(100), currency: 'USD', deletedAt: null });
    const r = await deleteOutwardRemittance({ prisma: makePrisma(tx), remittanceId: 'OWR__1' });
    expect(r.ok).toBe(true);
    expect(tx.outwardRemittance.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'OWR__1' },
      data: expect.objectContaining({ deletedAt: expect.any(BigInt) }),
    }));
  });

  it('不存在/已删 → REMITTANCE_NOT_FOUND', async () => {
    const { tx } = makeTx();
    tx.outwardRemittance.findUnique.mockResolvedValue(null);
    const r = await deleteOutwardRemittance({ prisma: makePrisma(tx), remittanceId: 'OWR__X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('REMITTANCE_NOT_FOUND');
  });
});

describe('C6 getVoucherRemittanceSummary / listOutwardRemittances', () => {
  it('摘要：已付/余额/fullyRemitted 计算正确', async () => {
    const prisma: any = {
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue(DISBURSEMENT_USD) },
      outwardRemittance: {
        findMany: vi.fn().mockResolvedValue([
          { foreignAmount: dec(2000), remitDate: '2026-08-02' },
          { foreignAmount: dec(3000), remitDate: '2026-08-05' },
        ]),
      },
    };
    const r = await getVoucherRemittanceSummary(prisma, 'PAY__D1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.remittedAmount).toBe('5000.0000');
      expect(r.data.remainingAmount).toBe('0.0000');
      expect(r.data.fullyRemitted).toBe(true);
      expect(r.data.remittances).toHaveLength(2);
    }
  });

  it('凭证不存在 → VOUCHER_NOT_FOUND', async () => {
    const prisma: any = { paymentVoucher: { findUnique: vi.fn().mockResolvedValue(null) } };
    const r = await getVoucherRemittanceSummary(prisma, 'PAY__X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VOUCHER_NOT_FOUND');
  });

  it('list：按 voucherId/期间过滤', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'OWR__1' }]);
    const prisma: any = { outwardRemittance: { findMany } };
    const r = await listOutwardRemittances(prisma, { voucherId: 'PAY__D1', from: '2026-08-01', to: '2026-08-31' });
    expect(r.total).toBe(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        voucherId: 'PAY__D1',
        deletedAt: null,
        remitDate: { gte: '2026-08-01', lte: '2026-08-31' },
      }),
    }));
  });
});
