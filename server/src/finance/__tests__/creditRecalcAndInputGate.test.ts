/**
 * 修复1（usedAmount 实时联动接线）+ 修复2（财务输入服务端防线）单测
 *
 * 修复1 接线断言：发票创建/更新、核销 applyAllocation、发票作废（cancelInvoice）
 *   均在事务内触发客户 usedAmount 重算 + CreditLimitHistory 留痕。
 * 修复2 校验断言：负金额 / 零汇率 / 非法币种 → INVALID_AMOUNT / INVALID_CURRENCY（route 映射 400）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createInvoice, updateInvoice, SUPPORTED_CURRENCIES } from '../invoiceMutationService';
import { createPaymentVoucher, updatePaymentVoucher } from '../paymentVoucherMutationService';
import { applyAllocation, readAllocationRefusal } from '../allocationService';
import { cancelInvoice } from '../voidDeleteService';

// ── helpers ────────────────────────────────────────────────────────

function dec(v: number | string) {
  return new Prisma.Decimal(v);
}

/** 事务 client mock：覆盖 applyAllocation/createInvoice/cancelInvoice 全部依赖 + 信用重算依赖 */
function makeTx(opts: {
  invoice?: any;
  invoicesById?: Record<string, any>;
  voucher?: any;
  invoicesForNet?: any[];
  allocationsForNet?: any[];
  creditLimit?: any | null;
} = {}) {
  const invoiceDefault = {
    id: 'INV__1', invoiceNumber: 'INV-1', type: 'Receivable', status: 'Issued',
    amount: dec('1000'), currency: 'USD', orderId: null,
    customerRelationId: 'REL_1', customerName: 'Cust', deletedAt: null,
    exchangeRate: null, issueDate: '2026-09-01',
    ...opts.invoice,
  };
  const invoiceForId = (id: string) => opts.invoicesById?.[id]
    ? { ...invoiceDefault, ...opts.invoicesById[id], id }
    : { ...invoiceDefault, id };
  const allocations: any[] = [];
  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offsets.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    materialReturn: { findMany: vi.fn(async () => []) },
    invoice: {
      create: vi.fn(async ({ data }: any) => ({ ...data })),
      findUnique: vi.fn(async ({ where }: any) => invoiceForId(where.id)),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => opts.invoicesForNet ?? []),
      update: vi.fn(async ({ where, data }: any) => ({ ...invoiceForId(where.id), ...data, id: where.id })),
    },
    paymentVoucher: {
      findUnique: vi.fn(async () => ({ id: 'PAY__1', type: 'Receipt', deletedAt: null, status: 'unreconciled', currency: 'USD', amount: dec('500'), ...opts.voucher })),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    invoiceAllocation: {
      count: vi.fn(async () => 0),
      // 三种调用形态：①applyAllocation 预检（invoiceId/voucherId 过滤，过滤当前对后为空）
      // ②recalcInvoiceStatus（invoiceId 过滤，upsert 后状态 → 返回本单核销）
      // ③computeNetOpenReceivables（invoiceId: { in: [...] } 形态 → 净额口径核销明细）
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.invoiceId && typeof where.invoiceId === 'object' && where.invoiceId.in) {
          return opts.allocationsForNet ?? [];
        }
        return allocations.filter(row => (!where?.invoiceId || row.invoiceId === where.invoiceId) && (!where?.voucherId || row.voucherId === where.voucherId));
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const index = allocations.findIndex(row => row.invoiceId === where.invoiceId_voucherId.invoiceId && row.voucherId === where.invoiceId_voucherId.voucherId);
        if (index < 0) { allocations.push(create); return create; }
        allocations[index] = { ...allocations[index], ...update }; return allocations[index];
      }),
      delete: vi.fn(async () => ({})),
    },
    invoiceOrderAllocation: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    order: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    entityReference: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    creditLimit: {
      findFirst: vi.fn(async () => opts.creditLimit === undefined ? null : opts.creditLimit),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    creditLimitHistory: { create: vi.fn(async () => ({})) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  return { tx, prisma };
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// 修复1：usedAmount 实时联动接线
// ═══════════════════════════════════════════════════════════════

describe('修复1：applyAllocation 核销 → 同事务重算 usedAmount + 留痕', () => {
  it('核销后净额变化 → creditLimit.update 覆写 + creditLimitHistory.create', async () => {
    const { tx, prisma } = makeTx({
      invoicesForNet: [{ id: 'INV__1', amount: dec('1000') }],
      allocationsForNet: [{ invoiceId: 'INV__1', appliedAmount: dec('400') }],
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: dec('1000'), deletedAt: null },
    });
    const r = await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'user_1', source: 'route:allocation:create',
    });
    expect(r.newInvoiceStatus).toBe('PartiallyPaid');
    // 净额 = 1000 − 400 = 600，覆写 usedAmount
    expect(tx.creditLimit.update).toHaveBeenCalledTimes(1);
    const written = tx.creditLimit.update.mock.calls[0][0].data.usedAmount;
    expect(written.toString()).toBe('600');
    // append-only 留痕：before 1000 → after 600
    expect(tx.creditLimitHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creditLimitId: 'CL_1',
          beforeUsedAmount: 1000,
          afterUsedAmount: 600,
          delta: -400,
          triggerType: 'credit_recalc',
        }),
      }),
    );
  });

  it('重算失败不阻断核销主业务（信用域异常被 hook 吞掉）', async () => {
    const { tx, prisma } = makeTx();
    tx.creditLimit.findFirst = vi.fn(async () => { throw new Error('CREDIT_DB_BOOM'); });
    const r = await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'user_1', source: 'route:allocation:create',
    });
    expect(r.allocationId).toBe('ALLOC__INV__1__PAY__1');
  });

  it('Payable 发票核销不触发信用重算', async () => {
    const { tx, prisma } = makeTx({ invoice: { type: 'Payable', customerRelationId: 'SUP_1' }, voucher: { type: 'Disbursement', customerRelationId: 'SUP_1' } });
    await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'user_1', source: 'route:allocation:create',
    });
    expect(tx.creditLimit.findFirst).not.toHaveBeenCalled();
    expect(tx.creditLimit.update).not.toHaveBeenCalled();
  });

  it('拒绝将付款凭证核销到另一供应商的应付发票，且不写 allocation', async () => {
    const { tx, prisma } = makeTx({
      invoice: { type: 'Payable', customerRelationId: 'SUPPLIER_A', customerName: '同名供应商' },
      voucher: { type: 'Disbursement', customerRelationId: 'SUPPLIER_B', customerName: '同名供应商', amount: dec('500') },
    });

    let refusal: any;
    try {
      await applyAllocation(prisma, tx, {
        invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '100',
        actorId: 'user_1', source: 'route:allocation:create',
      });
    } catch (error) {
      refusal = readAllocationRefusal(error);
    }

    expect(refusal).toMatchObject({
      code: 'PAYABLE_SUPPLIER_MISMATCH', statusCode: 409,
      message: expect.stringContaining('供应商不同'),
    });
    expect(tx.invoiceAllocation.upsert).not.toHaveBeenCalled();
  });

  it('同一张付款凭证可以分配给同一供应商的多张应付发票', async () => {
    const { tx, prisma } = makeTx({
      invoicesById: {
        'AP__1': { type: 'Payable', status: 'Issued', amount: dec('100'), currency: 'USD', customerRelationId: 'SUPPLIER_A', customerName: '供应商 A' },
        'AP__2': { type: 'Payable', status: 'Issued', amount: dec('100'), currency: 'USD', customerRelationId: 'SUPPLIER_A', customerName: '供应商 A' },
      },
      voucher: { type: 'Disbursement', customerRelationId: 'SUPPLIER_A', customerName: '供应商 A', amount: dec('200') },
    });

    await applyAllocation(prisma, tx, {
      invoiceId: 'AP__1', voucherId: 'PAY__1', appliedAmount: '100',
      actorId: 'user_1', source: 'route:allocation:create',
    });
    await applyAllocation(prisma, tx, {
      invoiceId: 'AP__2', voucherId: 'PAY__1', appliedAmount: '100',
      actorId: 'user_1', source: 'route:allocation:create',
    });

    expect(tx.invoiceAllocation.upsert).toHaveBeenCalledTimes(2);
    expect(tx.invoiceAllocation.upsert.mock.calls.map(([args]: any) => args.create.invoiceId)).toEqual(['AP__1', 'AP__2']);
  });

  it.each([
    ['应付发票缺少供应商档案关联', { invoice: { type: 'Payable', customerRelationId: null, customerName: '供应商 A' }, voucher: { type: 'Disbursement', customerRelationId: 'SUPPLIER_A', customerName: '供应商 A' } }],
    ['付款凭证缺少供应商档案关联', { invoice: { type: 'Payable', customerRelationId: 'SUPPLIER_A', customerName: '供应商 A' }, voucher: { type: 'Disbursement', customerRelationId: null, customerName: '供应商 A' } }],
  ])('%s 时 fail closed，不以展示名称代替 Relation ID', async (_caseName, options) => {
    const { tx, prisma } = makeTx(options as any);
    let refusal: any;
    try {
      await applyAllocation(prisma, tx, {
        invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '100',
        actorId: 'user_1', source: 'route:allocation:create',
      });
    } catch (error) {
      refusal = readAllocationRefusal(error);
    }

    expect(refusal).toMatchObject({
      code: 'PAYABLE_SUPPLIER_IDENTITY_REQUIRED', statusCode: 409,
      message: expect.stringContaining('缺少供应商档案关联'),
    });
    expect(tx.invoiceAllocation.upsert).not.toHaveBeenCalled();
  });
});

describe('修复1：createInvoice / updateInvoice → 重算接线', () => {
  it('创建 Receivable 发票（挂客户档案）→ 重算该客户', async () => {
    const { tx, prisma } = makeTx({
      invoicesForNet: [{ id: 'INV__NEW', amount: dec('100') }],
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: dec('0'), deletedAt: null },
    });
    const r = await createInvoice({
      prisma: prisma as any,
      input: {
        invoiceNumber: 'INV-T1', type: 'Receivable', amount: '100', currency: 'USD',
        status: 'Issued', customerRelationId: 'REL_1', issueDate: '2026-09-02',
      },
      actorId: 'user_1',
    });
    expect(r.ok).toBe(true);
    expect(tx.creditLimit.update).toHaveBeenCalledTimes(1);
    expect(tx.creditLimit.update.mock.calls[0][0].data.usedAmount.toString()).toBe('100');
    expect(tx.creditLimitHistory.create).toHaveBeenCalled();
  });

  it('创建 Payable 发票（供应商）→ 不触发信用重算', async () => {
    const { tx, prisma } = makeTx();
    const r = await createInvoice({
      prisma: prisma as any,
      input: {
        invoiceNumber: 'INV-T2', type: 'Payable', amount: '100', currency: 'USD',
        status: 'Issued', customerRelationId: 'SUP_1', issueDate: '2026-09-02',
      },
      actorId: 'user_1',
    });
    expect(r.ok).toBe(true);
    expect(tx.creditLimit.findFirst).not.toHaveBeenCalled();
  });

  it('更新发票（客户档案迁移）→ 新旧客户都重算', async () => {
    const { tx, prisma } = makeTx({
      invoice: { customerRelationId: 'REL_OLD' },
      invoicesForNet: [],
      creditLimit: { id: 'CL_1', relationId: 'REL_OLD', usedAmount: dec('500'), deletedAt: null },
    });
    // 更新后发票行挂新客户 REL_NEW
    tx.invoice.update = vi.fn(async ({ where, data }: any) => ({
      id: where.id, type: 'Receivable', status: 'Issued', amount: dec('1000'),
      currency: 'USD', customerRelationId: 'REL_NEW', customerName: 'Cust',
      deletedAt: null, exchangeRate: null, issueDate: '2026-09-01', ...data,
    }));
    const r = await updateInvoice({
      prisma: prisma as any, invoiceId: 'INV__1',
      input: { customerRelationId: 'REL_NEW' },
      actorId: 'user_1',
    });
    expect(r.ok).toBe(true);
    // 两个 relation 各触发一次重算（值无变化也会走查询，但覆写仅在变化时发生）
    const probedRelations = tx.creditLimit.findFirst.mock.calls.map((c: any[]) => c[0].where.relationId);
    expect(probedRelations).toContain('REL_OLD');
    expect(probedRelations).toContain('REL_NEW');
  });
});

describe('修复1：cancelInvoice 作废 → 重算接线', () => {
  it('作废 Receivable 发票 → 重算该客户（应收退出净额口径）', async () => {
    const { tx, prisma } = makeTx({
      invoicesForNet: [],
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: dec('1000'), deletedAt: null },
    });
    const r = await cancelInvoice({ prisma: prisma as any, invoiceId: 'INV__1', actorId: 'user_1', reason: '开错' });
    expect(r.ok).toBe(true);
    expect(tx.creditLimit.update).toHaveBeenCalledTimes(1);
    expect(tx.creditLimitHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ beforeUsedAmount: 1000, afterUsedAmount: 0 }),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 修复2：财务输入服务端防线（金额/汇率/币种）
// ═══════════════════════════════════════════════════════════════

describe('修复2：createInvoice 输入校验', () => {
  const base = { invoiceNumber: 'INV-V1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-09-02' };
  const emptyPrisma = {} as any;

  it('负金额 → INVALID_AMOUNT（中文消息）', async () => {
    const r = await createInvoice({ prisma: emptyPrisma, input: { ...base, amount: '-5' } });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVALID_AMOUNT');
    expect(r.error!.message).toContain('不能为负数');
  });

  it('零/负汇率 → INVALID_AMOUNT（汇率必须 >0）', async () => {
    const r0 = await createInvoice({ prisma: emptyPrisma, input: { ...base, exchangeRate: '0' } });
    expect(r0.ok).toBe(false);
    expect(r0.error!.code).toBe('INVALID_AMOUNT');
    expect(r0.error!.message).toContain('正数');
    const rNeg = await createInvoice({ prisma: emptyPrisma, input: { ...base, exchangeRate: '-7.1' } });
    expect(rNeg.ok).toBe(false);
    expect(rNeg.error!.code).toBe('INVALID_AMOUNT');
  });

  it('非法币种 → INVALID_CURRENCY（白名单外自由文本拒绝）', async () => {
    const r = await createInvoice({ prisma: emptyPrisma, input: { ...base, currency: 'RMB' } });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVALID_CURRENCY');
    expect(r.error!.message).toContain('USD');
  });

  it('updateInvoice 同款校验（PATCH 路径）', async () => {
    const rCur = await updateInvoice({ prisma: emptyPrisma, invoiceId: 'INV__1', input: { currency: 'XXY' } });
    expect(rCur.ok).toBe(false);
    expect(rCur.error!.code).toBe('INVALID_CURRENCY');
    const rAmt = await updateInvoice({ prisma: emptyPrisma, invoiceId: 'INV__1', input: { amount: '-1' } });
    expect(rAmt.ok).toBe(false);
    expect(rAmt.error!.code).toBe('INVALID_AMOUNT');
    const rFx = await updateInvoice({ prisma: emptyPrisma, invoiceId: 'INV__1', input: { exchangeRate: '0' } });
    expect(rFx.ok).toBe(false);
    expect(rFx.error!.code).toBe('INVALID_AMOUNT');
  });

  it('白名单本身与 DB 既有币种对齐（USD/EUR/CNY/GBP/JPY/HKD + AUD/CAD）', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual(
      expect.arrayContaining(['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'HKD', 'AUD', 'CAD']),
    );
  });
});

describe('修复2：createPaymentVoucher / updatePaymentVoucher 输入校验', () => {
  const base = { type: 'Receipt', amount: '100', currency: 'USD', paymentMethod: 'TT' } as any;
  const emptyPrisma = {} as any;

  it('负金额 → INVALID_AMOUNT', async () => {
    const r = await createPaymentVoucher({ prisma: emptyPrisma, input: { ...base, amount: '-50' } });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVALID_AMOUNT');
  });

  it('零/负汇率 → INVALID_AMOUNT', async () => {
    const r = await createPaymentVoucher({ prisma: emptyPrisma, input: { ...base, exchangeRate: '0' } });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVALID_AMOUNT');
    expect(r.error!.message).toContain('正数');
  });

  it('负银行费用 / 负预分配金额 → INVALID_AMOUNT', async () => {
    const rFee = await createPaymentVoucher({ prisma: emptyPrisma, input: { ...base, bankFee: '-1' } });
    expect(rFee.ok).toBe(false);
    expect(rFee.error!.code).toBe('INVALID_AMOUNT');
    const rApplied = await createPaymentVoucher({ prisma: emptyPrisma, input: { ...base, appliedAmount: '-1' } });
    expect(rApplied.ok).toBe(false);
    expect(rApplied.error!.code).toBe('INVALID_AMOUNT');
  });

  it('非法币种 → INVALID_CURRENCY', async () => {
    const r = await createPaymentVoucher({ prisma: emptyPrisma, input: { ...base, currency: '_usd_' } });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVALID_CURRENCY');
  });

  it('updatePaymentVoucher 同款校验（PATCH 路径）', async () => {
    const rCur = await updatePaymentVoucher({ prisma: emptyPrisma, voucherId: 'PAY__1', input: { currency: 'ZZZ' } });
    expect(rCur.ok).toBe(false);
    expect(rCur.error!.code).toBe('INVALID_CURRENCY');
    const rFx = await updatePaymentVoucher({ prisma: emptyPrisma, voucherId: 'PAY__1', input: { exchangeRate: '-1' } });
    expect(rFx.ok).toBe(false);
    expect(rFx.error!.code).toBe('INVALID_AMOUNT');
  });
});
