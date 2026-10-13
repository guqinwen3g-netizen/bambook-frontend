/**
 * §10.3-2 回款认领·业务员通道 — 服务层测试。
 *
 * 覆盖安全边界（防认错钱 / 防越权）：
 *   ① 仅 Receipt 凭证、未核销完；② 仅自己可见订单的应收发票；
 *   ③ **第三方代付：允许 + 留痕**（L2 高危 3 号，Kevin 2026-09-17 拍板；
 *      修前是硬拒 CUSTOMER_MISMATCH —— 母公司/货代/境外关联方代付都会被卡死）；
 *   ④ 币种一致；⑤ 金额不超额。
 * 以及列表：仅下发挂自己可见客户的收款（未挂客户不下发，防跨客泄露）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { claimReceipt, listClaimableReceipts } from '../receiptClaimService';

// ── 核销写链路（既有，含 Serializable 事务 + 审计）在本测试内 mock ──
vi.mock('../allocationMutationService', () => ({
  ledgerResult: vi.fn(),
  appendReceiptAllocation: async (p: any) => { try { await p.validate(p.prisma); const m = await import('../allocationMutationService'); return (m as any).ledgerResult(p); } catch (e: any) { return { ok: false, error: { code: e.claimCode, message: e.message } }; } },
}));
// sendToUser 提到 hoisted 里，便于断言「代付」是否被点名（留痕面）
// ⚠️ 路径相对**测试文件**解析：测试在 src/finance/__tests__/ 下，
//    模块真身在 src/notifications/ → 必须 '../../notifications/...'。
//    （旧写法 '../notifications/...' 会解析到不存在的 src/finance/notifications/，
//     mock 静默不生效、跑的是真通知服务 —— 只因当时没断言 sendToUser 才一直没暴露。）
const { sendToUserSpy } = vi.hoisted(() => ({ sendToUserSpy: vi.fn().mockResolvedValue(null) }));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: vi.fn(() => ({ sendToUser: sendToUserSpy })),
}));

const { ledgerResult: appendReceiptAllocation } = await import('../allocationMutationService') as any;

const ALLOC_OK = {
  ok: true,
  data: {
    allocation: { id: 'ALLOC_1', invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '500', appliedDate: '2026-09-12' },
    newInvoiceStatus: 'PartiallyPaid', newVoucherStatus: 'partially_reconciled',
    voucherAppliedAmount: '500', auditId: 'AUD_1',
  },
} as any;

const RECEIPT = {
  id: 'PAY__1', voucherNumber: 'PAY-20260912-001', type: 'Receipt', status: 'unreconciled',
  amount: '1000.0000', currency: 'USD', customerRelationId: 'REL_1', customerName: 'ACME',
  deletedAt: null,
};
const INVOICE = {
  id: 'INV__1', invoiceNumber: 'INV-20260912-001', type: 'Receivable', status: 'Issued',
  amount: '800.0000', currency: 'USD', orderId: 'SO_1', customerRelationId: 'REL_1', deletedAt: null,
};

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    paymentVoucher: { findFirst: vi.fn().mockResolvedValue(RECEIPT), findMany: vi.fn().mockResolvedValue([RECEIPT]) },
    invoice: { findFirst: vi.fn().mockResolvedValue(INVOICE) },
    invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    order: { findMany: vi.fn().mockResolvedValue([{ customerRelationId: 'REL_1' }]) },
    userRole: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as PrismaClient;
}

const beforeEachReset = () => { vi.mocked(appendReceiptAllocation).mockReset(); };


describe('claimReceipt：安全边界', () => {
  it('正常认领 → 复用 appendReceiptAllocation，返回核销结果', async () => {
    beforeEachReset();
    vi.mocked(appendReceiptAllocation).mockResolvedValue({
      ok: true,
      data: {
        allocation: { id: 'ALLOC_1', invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '500', appliedDate: '2026-09-12' },
        newInvoiceStatus: 'PartiallyPaid', newVoucherStatus: 'partially_reconciled',
        voucherAppliedAmount: '500', auditId: 'AUD_1',
      },
    } as any);
    const res = await claimReceipt(makePrisma(), {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 500,
      requestId: 'request-test', actorId: 'u_sales', visibleOrderIds: ['SO_1'],
    });
    expect(res.ok).toBe(true);
    expect(res.data?.allocationId).toBe('ALLOC_1');
    expect(vi.mocked(appendReceiptAllocation)).toHaveBeenCalledTimes(1);
  });

  it('① 非收款凭证（Disbursement）→ NOT_A_RECEIPT', async () => {
    beforeEachReset();
    const prisma = makePrisma({
      paymentVoucher: { findFirst: vi.fn().mockResolvedValue({ ...RECEIPT, type: 'Disbursement' }) },
    });
    const res = await claimReceipt(prisma, {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.error?.code).toBe('NOT_A_RECEIPT');
    expect(vi.mocked(appendReceiptAllocation)).not.toHaveBeenCalled();
  });

  it('① 已全额核销 → VOUCHER_RECONCILED', async () => {
    beforeEachReset();
    const prisma = makePrisma({
      paymentVoucher: { findFirst: vi.fn().mockResolvedValue({ ...RECEIPT, status: 'reconciled' }) },
    });
    const res = await claimReceipt(prisma, {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.error?.code).toBe('VOUCHER_RECONCILED');
  });

  it('② 发票不在可见订单白名单 → INVOICE_NOT_VISIBLE（防越权认领）', async () => {
    beforeEachReset();
    const res = await claimReceipt(makePrisma(), {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u_sales', visibleOrderIds: ['SO_OTHER'],
    });
    expect(res.error?.code).toBe('INVOICE_NOT_VISIBLE');
    expect(vi.mocked(appendReceiptAllocation)).not.toHaveBeenCalled();
  });

  it('② 白名单为空数组 → 同样拒绝（不得因空数组放行）', async () => {
    beforeEachReset();
    const res = await claimReceipt(makePrisma(), {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u_sales', visibleOrderIds: [],
    });
    expect(res.error?.code).toBe('INVOICE_NOT_VISIBLE');
  });

  it('③ 客户不一致 → **放行**（第三方代付允许），且通知财务文案点名代付（修前硬拒 CUSTOMER_MISMATCH）', async () => {
    beforeEachReset();
    sendToUserSpy.mockClear();
    vi.mocked(appendReceiptAllocation).mockResolvedValue(ALLOC_OK);
    const prisma = makePrisma({
      invoice: { findFirst: vi.fn().mockResolvedValue({ ...INVOICE, customerRelationId: 'REL_2', customerName: 'OTHER CO' }) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'u_fin' }]) },
    });
    const res = await claimReceipt(prisma, {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.ok).toBe(true);                                      // ★ 不再被硬拒
    expect(vi.mocked(appendReceiptAllocation)).toHaveBeenCalledTimes(1);    // 走既有核销真源落库
    expect(sendToUserSpy).toHaveBeenCalledTimes(1);
    const note = sendToUserSpy.mock.calls[0][0] as any;
    expect(note.title).toContain('第三方代付');                       // ★ 留痕：财务被点名
    expect(note.body).toContain('第三方代付');
  });

  it('③ 客户一致 → 不误报代付（通知文案不带「第三方代付」）', async () => {
    beforeEachReset();
    sendToUserSpy.mockClear();
    vi.mocked(appendReceiptAllocation).mockResolvedValue(ALLOC_OK);
    const prisma = makePrisma({
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'u_fin' }]) },
    });
    const res = await claimReceipt(prisma, {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.ok).toBe(true);
    const note = sendToUserSpy.mock.calls[0][0] as any;
    expect(note.title).not.toContain('第三方代付');
    expect(note.body).not.toContain('第三方代付');
  });

  it('④ 币种不一致 → CURRENCY_MISMATCH（不做自动换算）', async () => {
    beforeEachReset();
    const prisma = makePrisma({
      invoice: { findFirst: vi.fn().mockResolvedValue({ ...INVOICE, currency: 'CNY' }) },
    });
    const res = await claimReceipt(prisma, {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 100, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.error?.code).toBe('CURRENCY_MISMATCH');
  });

  it('⑤ 超额（超发票未收余额）→ AMOUNT_EXCEEDED', async () => {
    beforeEachReset();
    const res = await claimReceipt(makePrisma(), {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 900, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.error?.code).toBe('AMOUNT_EXCEEDED');
    expect(res.error?.message).toContain('800.00');
  });

  it('非应收发票 / 草稿或已结清 → 拒绝（NOT_RECEIVABLE / INVOICE_NOT_CLAIMABLE）', async () => {
    beforeEachReset();
    const payable = makePrisma({ invoice: { findFirst: vi.fn().mockResolvedValue({ ...INVOICE, type: 'Payable' }) } });
    expect((await claimReceipt(payable, { voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 1, requestId: 'request-test', actorId: 'u', visibleOrderIds: null })).error?.code)
      .toBe('NOT_RECEIVABLE');

    const paid = makePrisma({ invoice: { findFirst: vi.fn().mockResolvedValue({ ...INVOICE, status: 'Paid' }) } });
    expect((await claimReceipt(paid, { voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 1, requestId: 'request-test', actorId: 'u', visibleOrderIds: null })).error?.code)
      .toBe('INVOICE_NOT_CLAIMABLE');
  });

  it('金额非正数 → INVALID_AMOUNT', async () => {
    beforeEachReset();
    const res = await claimReceipt(makePrisma(), {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 0, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.error?.code).toBe('INVALID_AMOUNT');
  });
});

describe('listClaimableReceipts：可见性与未核销过滤', () => {
  it('只下发挂自己可见客户、且有未核销余额的收款', async () => {
    const prisma = makePrisma({
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue([{ voucherId: 'PAY__1', appliedAmount: '400' }]) },
    });
    const res = await listClaimableReceipts(prisma, { visibleOrderIds: ['SO_1'] });
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data![0].unapplied).toBe(600); // 1000 - 400
  });

  it('已无未核销余额（全额核销）→ 不下发', async () => {
    const prisma = makePrisma({
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue([{ voucherId: 'PAY__1', appliedAmount: '1000' }]) },
    });
    const res = await listClaimableReceipts(prisma, { visibleOrderIds: ['SO_1'] });
    expect(res.data).toHaveLength(0);
  });

  it('可见订单为空 → 空列表（不越权下发）', async () => {
    const res = await listClaimableReceipts(makePrisma(), { visibleOrderIds: [] });
    expect(res.data).toEqual([]);
  });

  it('可见订单关联不到客户 → 空列表', async () => {
    const prisma = makePrisma({ order: { findMany: vi.fn().mockResolvedValue([{ customerRelationId: null }]) } });
    const res = await listClaimableReceipts(prisma, { visibleOrderIds: ['SO_1'] });
    expect(res.data).toEqual([]);
  });

  it('visibleOrderIds=null（财务/领导不受限）→ 不下客户过滤', async () => {
    const prisma = makePrisma();
    const res = await listClaimableReceipts(prisma, { visibleOrderIds: null });
    expect(res.data).toHaveLength(1);
    // 不受限时不应去查 order 反推客户
    expect((prisma as any).order.findMany).not.toHaveBeenCalled();
  });
});

/**
 * ★ 口径 E3（2026-09-17 业务方拍板）：**0 元票不可认领**。
 *
 * 理由：认领一个"没有金额可认领"的票语义上无意义（认领后剩余 = 0）。
 * 判据复用**唯一真源** `shared/openReceivable.hasOpenAmount`（不手写），
 * 它同时覆盖两种情形：`amount === 0`（0 元票）与 `amount < 0`（负向贷项票）。
 * 见 `docs/业务口径决策单-2026-09-17.md` E3。
 */
describe('★ 口径 E3：0 元票 / 负额票不可认领', () => {
  const claim = (prisma: any) =>
    claimReceipt(prisma, { voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 1, requestId: 'request-test', actorId: 'u', visibleOrderIds: null });

  it('★ 承重：amount = 0 的应收票 → INVOICE_NOT_CLAIMABLE', async () => {
    const zero = makePrisma({ invoice: { findFirst: vi.fn().mockResolvedValue({ ...INVOICE, amount: '0.0000' }) } });
    expect((await claim(zero)).error?.code).toBe('INVOICE_NOT_CLAIMABLE');
  });

  it('★ 对照：amount < 0 的负向贷项票同样不可认领（不是"可收的钱"）', async () => {
    const neg = makePrisma({ invoice: { findFirst: vi.fn().mockResolvedValue({ ...INVOICE, amount: '-500.0000' }) } });
    expect((await claim(neg)).error?.code).toBe('INVOICE_NOT_CLAIMABLE');
  });

  it('★ 阳性对照：正常金额的票仍可认领 —— 证明本守卫不是"把认领全拒了"', async () => {
    beforeEachReset();
    vi.mocked(appendReceiptAllocation).mockResolvedValue(ALLOC_OK);
    const res = await claimReceipt(makePrisma(), {
      voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 500, requestId: 'request-test', actorId: 'u', visibleOrderIds: null,
    });
    expect(res.ok).toBe(true);
  });
});

it('作废收款不可核销；贷项抵扣占用余额', async () => {
  const cancelled = makePrisma({ paymentVoucher: { findFirst: vi.fn().mockResolvedValue({ ...RECEIPT, status: 'cancelled' }) } });
  expect((await claimReceipt(cancelled, { voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 1, actorId: 'u', requestId: 'cancelled', visibleOrderIds: null })).error?.code).toBe('INVOICE_NOT_CLAIMABLE');
  const credited = makePrisma({ creditNoteAllocation: { findMany: vi.fn().mockResolvedValue([{ appliedAmount: 700 }]) } });
  expect((await claimReceipt(credited, { voucherId: 'PAY__1', invoiceId: 'INV__1', amount: 200, actorId: 'u', requestId: 'credit', visibleOrderIds: null })).error?.code).toBe('AMOUNT_EXCEEDED');
});
