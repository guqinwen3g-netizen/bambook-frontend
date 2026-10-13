/**
 * 阶段 F / F2 — fxSettlementService 单测
 * 覆盖：createFxSettlement 校验链（fail closed）/ cnyAmount 服务端计算 / 分次结汇与超结阻断 /
 *       deleteFxSettlement 软删回滚 / getVoucherSettlementSummary / getFxLedger 台账聚合
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createFxSettlement,
  deleteFxSettlement,
  getVoucherSettlementSummary,
  getFxLedger,
} from '../fxSettlementService';

// ── mock  helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const RECEIPT_USD = {
  id: 'PAY__1', voucherNumber: 'PAY-20260801-001', type: 'Receipt',
  amount: dec(10000), currency: 'USD', exchangeRate: dec('7.10'),
  orderId: 'ORD__1', customerRelationId: 'REL__1', customerName: 'Peerless',
  paymentDate: '2026-08-01', deletedAt: null,
};

function makeTx(overrides: {
  voucher?: any;
  existingSettlements?: any[];
  createFail?: boolean;
} = {}) {
  const voucher = overrides.voucher === undefined ? RECEIPT_USD : overrides.voucher;
  const fxSettlementFindMany = vi.fn().mockResolvedValue(overrides.existingSettlements ?? []);
  const fxSettlementCreate = overrides.createFail
    ? vi.fn().mockRejectedValue(new Error('DB_DOWN'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const tx = {
    paymentVoucher: { findUnique: vi.fn().mockResolvedValue(voucher) },
    fxSettlement: {
      findMany: fxSettlementFindMany,
      create: fxSettlementCreate,
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
  return { tx, fxSettlementCreate, fxSettlementFindMany };
}

function makePrisma(tx: any) {
  return { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('F2 createFxSettlement 输入校验（fail closed）', () => {
  it('缺 voucherId → INVALID_INPUT', async () => {
    const r = await createFxSettlement({ prisma: {} as any, input: { voucherId: '', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('非法 settleDate → INVALID_DATE', async () => {
    const r = await createFxSettlement({ prisma: {} as any, input: { voucherId: 'PAY__1', settleDate: '2026/08/08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DATE');
  });

  it('foreignAmount ≤ 0 → INVALID_AMOUNT', async () => {
    const r = await createFxSettlement({ prisma: {} as any, input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: -5, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
  });

  it('fxRate ≤ 0 → INVALID_AMOUNT', async () => {
    const r = await createFxSettlement({ prisma: {} as any, input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
  });

  it('客户端传 cnyAmount → INVALID_INPUT（服务端计算口径，防篡改）', async () => {
    const r = await createFxSettlement({ prisma: {} as any, input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1, cnyAmount: 999 } as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });
});

describe('F2 createFxSettlement 凭证与核销校验', () => {
  it('凭证不存在 → VOUCHER_NOT_FOUND', async () => {
    const { tx } = makeTx({ voucher: null });
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'NOPE', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VOUCHER_NOT_FOUND');
  });

  it('Disbursement 凭证 → NOT_A_RECEIPT', async () => {
    const { tx } = makeTx({ voucher: { ...RECEIPT_USD, type: 'Disbursement' } });
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_A_RECEIPT');
  });

  it('CNY 凭证 → CNY_VOUCHER_NO_SETTLEMENT', async () => {
    const { tx } = makeTx({ voucher: { ...RECEIPT_USD, currency: 'CNY' } });
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CNY_VOUCHER_NO_SETTLEMENT');
  });

  it('显式 currency 与凭证不一致 → CURRENCY_MISMATCH', async () => {
    const { tx } = makeTx();
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 100, currency: 'EUR', fxRate: 7.8 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('超结阻断：已结 8000 / 凭证 10000，再结 3000 → OVER_SETTLEMENT（409 语义）', async () => {
    const { tx, fxSettlementCreate } = makeTx({ existingSettlements: [{ foreignAmount: dec(8000) }] });
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 3000, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('OVER_SETTLEMENT');
      expect(r.error.message).toContain('2000'); // remaining 余额可见
    }
    expect(fxSettlementCreate).not.toHaveBeenCalled();
  });

  it('分次结汇允许：已结 8000，再结 2000（=剩余全额）→ 成功', async () => {
    const { tx, fxSettlementCreate } = makeTx({ existingSettlements: [{ foreignAmount: dec(8000) }] });
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 2000, fxRate: 7.15 } });
    expect(r.ok).toBe(true);
    expect(fxSettlementCreate).toHaveBeenCalledTimes(1);
  });
});

describe('F2 createFxSettlement 成功路径', () => {
  it('cnyAmount 服务端计算 = round4(foreign × rate)；orderId/customerRelationId 从凭证继承；sync+audit 同事务', async () => {
    const { tx, fxSettlementCreate } = makeTx();
    const r = await createFxSettlement({
      prisma: makePrisma(tx),
      input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 5000, fxRate: 7.12345678, bank: 'Bank of China', slipNumber: 'BOC-123' },
    });
    expect(r.ok).toBe(true);
    const data = fxSettlementCreate.mock.calls[0][0].data;
    expect(data.voucherId).toBe('PAY__1');
    expect(data.orderId).toBe('ORD__1');           // 继承凭证，不接受客户端覆盖
    expect(data.customerRelationId).toBe('REL__1');
    expect(data.currency).toBe('USD');              // 缺省继承凭证币种
    expect(data.cnyAmount.toString()).toBe((5000 * 7.12345678).toFixed(4)); // 35617.2839
    expect(data.id).toMatch(/^FXS__/);
    expect(data.settlementNumber).toMatch(/^FXS-20260808-/);
    // sync（entityReference/entityLink upsert）+ audit 同事务
    expect(tx.entityReference.upsert).toHaveBeenCalled();
    expect(tx.entityLink.upsert).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    if (r.ok) expect(r.data.auditId).toBeTruthy();
  });

  it('DB 异常 → CREATE_FAILED（不伪成功）', async () => {
    const { tx } = makeTx({ createFail: true });
    const r = await createFxSettlement({ prisma: makePrisma(tx), input: { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 100, fxRate: 7.1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CREATE_FAILED');
  });
});

describe('F2 deleteFxSettlement（软删回滚核销余额）', () => {
  it('不存在 → SETTLEMENT_NOT_FOUND', async () => {
    const { tx } = makeTx();
    tx.fxSettlement.findUnique.mockResolvedValue(null);
    const r = await deleteFxSettlement({ prisma: makePrisma(tx), settlementId: 'NOPE' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SETTLEMENT_NOT_FOUND');
  });

  it('成功 → deletedAt 落库 + 图谱链接 deactivate + audit', async () => {
    const { tx } = makeTx();
    tx.fxSettlement.findUnique.mockResolvedValue({ id: 'FXS__1', settlementNumber: 'FXS-1', voucherId: 'PAY__1', foreignAmount: dec(100), currency: 'USD', deletedAt: null });
    const r = await deleteFxSettlement({ prisma: makePrisma(tx), settlementId: 'FXS__1' });
    expect(r.ok).toBe(true);
    const updateData = tx.fxSettlement.update.mock.calls[0][0].data;
    expect(updateData.deletedAt).toBeTruthy();
    // deactivateEntityLinks：link + reference 均置 inactive
    expect(tx.entityLink.findMany).toHaveBeenCalled();
    expect(tx.entityLink.update).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('F2 getVoucherSettlementSummary', () => {
  it('已结 6000 / 凭证 10000 → remaining 4000，fullySettled=false', async () => {
    const prisma = {
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue(RECEIPT_USD) },
      fxSettlement: { findMany: vi.fn().mockResolvedValue([{ foreignAmount: dec(6000) }]) },
    } as any;
    const r = await getVoucherSettlementSummary(prisma, 'PAY__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.settledAmount).toBe('6000.0000');
      expect(r.data.remainingAmount).toBe('4000.0000');
      expect(r.data.fullySettled).toBe(false);
    }
  });

  it('凭证不存在 → VOUCHER_NOT_FOUND', async () => {
    const prisma = { paymentVoucher: { findUnique: vi.fn().mockResolvedValue(null) }, fxSettlement: { findMany: vi.fn() } } as any;
    const r = await getVoucherSettlementSummary(prisma, 'NOPE');
    expect(r.ok).toBe(false);
  });
});

describe('F2 getFxLedger 台账聚合', () => {
  it('按币种分行：收汇/已结汇/未结汇/加权汇率/汇兑差额估算', async () => {
    const prisma = {
      paymentVoucher: {
        findMany: vi.fn()
          // 第一次调用：期间内收汇
          .mockResolvedValueOnce([{ id: 'PAY__1', voucherNumber: 'PAY-1', amount: dec(10000), currency: 'USD', exchangeRate: dec('7.10'), paymentDate: '2026-08-01', customerName: 'Peerless' }])
          // 第二次调用：settlement 关联凭证汇率快照
          .mockResolvedValueOnce([{ id: 'PAY__1', exchangeRate: dec('7.10'), currency: 'USD' }])
          // 第三次调用：全量外币 Receipt（未结汇余额口径）
          .mockResolvedValueOnce([{ id: 'PAY__1', voucherNumber: 'PAY-1', amount: dec(10000), currency: 'USD', paymentDate: '2026-08-01', customerName: 'Peerless' }]),
      },
      fxSettlement: {
        findMany: vi.fn()
          // 期间内结汇
          .mockResolvedValueOnce([{ voucherId: 'PAY__1', currency: 'USD', foreignAmount: dec(4000), cnyAmount: dec(28800), fxRate: dec('7.20'), settleDate: '2026-08-05' }])
          // 全量结汇
          .mockResolvedValueOnce([{ voucherId: 'PAY__1', foreignAmount: dec(4000) }]),
      },
    } as any;
    const ledger = await getFxLedger(prisma, { from: '2026-08-01', to: '2026-08-31' });
    expect(ledger.rows).toHaveLength(1);
    const row = ledger.rows[0];
    expect(row.currency).toBe('USD');
    expect(row.receivedTotal).toBe('10000.0000');
    expect(row.settledTotal).toBe('4000.0000');
    expect(row.unsettledBalance).toBe('6000.0000');
    expect(row.settlementCount).toBe(1);
    expect(row.weightedAvgSettleRate).toBe('7.20000000'); // 28800/4000
    expect(row.fxDiffEstimate).toBe('400.0000');          // (7.20-7.10)×4000
    expect(ledger.unsettledVouchers).toHaveLength(1);
    expect(ledger.unsettledVouchers[0].remainingAmount).toBe('6000.0000');
  });

  it('无结汇记录时 weightedAvgSettleRate/fxDiffEstimate 为 null', async () => {
    const prisma = {
      paymentVoucher: {
        findMany: vi.fn()
          // 期间内收汇
          .mockResolvedValueOnce([{ id: 'PAY__2', voucherNumber: 'PAY-2', amount: dec(500), currency: 'EUR', exchangeRate: null, paymentDate: '2026-08-02', customerName: null }])
          // 全量外币 Receipt（期间无结汇 → settlement 关联凭证查询被跳过）
          .mockResolvedValueOnce([{ id: 'PAY__2', voucherNumber: 'PAY-2', amount: dec(500), currency: 'EUR', paymentDate: '2026-08-02', customerName: null }]),
      },
      fxSettlement: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;
    const ledger = await getFxLedger(prisma, {});
    const row = ledger.rows.find(r => r.currency === 'EUR');
    expect(row).toBeTruthy();
    expect(row!.weightedAvgSettleRate).toBeNull();
    expect(row!.fxDiffEstimate).toBeNull();
    expect(row!.unsettledBalance).toBe('500.0000');
  });
});
