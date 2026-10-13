/**
 * 修复1（信用域空转）单测：净额口径计算 + usedAmount 事件驱动重算 + 留痕
 *
 * 覆盖：
 *   - computeNetOpenReceivables：净额口径（Σ amount − Σ核销；Cancelled/Void/软删/Payable 排除）
 *   - recalculateCustomerCredit：绝对值覆写幂等（值不变 no-op 不写历史）、变化时覆写+append history
 *   - notifyCustomerCreditRecalc：invoiceId 只解析 Receivable、失败不阻断（catch + warn）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  computeNetOpenReceivables,
  recalculateCustomerCredit,
  notifyCustomerCreditRecalc,
} from '../creditService';

function makeDb(opts: {
  invoices?: any[];
  allocations?: any[];
  creditLimit?: any | null;
} = {}) {
  return {
    invoice: {
      findMany: vi.fn().mockResolvedValue(opts.invoices ?? []),
      findUnique: vi.fn().mockResolvedValue(opts.invoiceById ?? null),
    },
    invoiceAllocation: {
      findMany: vi.fn().mockResolvedValue(opts.allocations ?? []),
    },
    creditLimit: {
      findFirst: vi.fn().mockResolvedValue(opts.creditLimit === undefined ? null : opts.creditLimit),
      update: vi.fn().mockResolvedValue({}),
    },
    creditLimitHistory: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('computeNetOpenReceivables（净额口径单一真源）', () => {
  it('无应收发票 → 0', async () => {
    const db = makeDb();
    expect((await computeNetOpenReceivables(db, 'REL_1')).toNumber()).toBe(0);
  });

  it('Σ amount − Σ核销：部分核销只计净额', async () => {
    const db = makeDb({
      invoices: [
        { id: 'I1', amount: new Prisma.Decimal('10000') },
        { id: 'I2', amount: new Prisma.Decimal('5000') },
      ],
      allocations: [
        { invoiceId: 'I1', appliedAmount: new Prisma.Decimal('3000') },
        { invoiceId: 'I2', appliedAmount: new Prisma.Decimal('5000') }, // I2 全额核销 → 净额 0
      ],
    });
    expect((await computeNetOpenReceivables(db, 'REL_1')).toNumber()).toBe(7000);
  });

  it('查询口径：type=Receivable / status∉Cancelled,Void / 未软删 / 按客户过滤', async () => {
    const db = makeDb({ invoices: [], allocations: [] });
    await computeNetOpenReceivables(db, 'REL_1');
    expect(db.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          type: 'Receivable',
          status: { notIn: ['Cancelled', 'Void'] },
          customerRelationId: 'REL_1',
        },
      }),
    );
  });
});

describe('recalculateCustomerCredit（绝对值覆写幂等 + 留痕）', () => {
  it('无 CreditLimit 行 → null（跳过，与 reserve/release 语义一致）', async () => {
    const db = makeDb({ creditLimit: null });
    expect(await recalculateCustomerCredit(db, { relationId: 'REL_1', reason: 'test' })).toBeNull();
    expect(db.creditLimit.update).not.toHaveBeenCalled();
  });

  it('净额变化 → 覆写 usedAmount + append CreditLimitHistory（before/after/reason）', async () => {
    const db = makeDb({
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: new Prisma.Decimal('8000'), deletedAt: null },
      invoices: [{ id: 'I1', amount: new Prisma.Decimal('10000') }],
      allocations: [{ invoiceId: 'I1', appliedAmount: new Prisma.Decimal('3000') }],
    });
    const r = await recalculateCustomerCredit(db, {
      relationId: 'REL_1',
      triggerId: 'ALLOC__I1__V1',
      triggerBy: 'user_1',
      reason: '核销后重算',
    });
    expect(r).toEqual({ recalculated: true, before: 8000, after: 7000 });
    expect(db.creditLimit.update).toHaveBeenCalledWith({
      where: { id: 'CL_1' },
      data: expect.objectContaining({ usedAmount: expect.any(Prisma.Decimal) }),
    });
    const written = db.creditLimit.update.mock.calls[0][0].data.usedAmount;
    expect(written.toString()).toBe('7000');
    expect(db.creditLimitHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creditLimitId: 'CL_1',
          beforeUsedAmount: 8000,
          afterUsedAmount: 7000,
          delta: -1000,
          triggerType: 'credit_recalc',
          triggerId: 'ALLOC__I1__V1',
          triggerBy: 'user_1',
          remark: '核销后重算',
        }),
      }),
    );
  });

  it('净额无变化 → no-op（不写库不写历史，幂等防噪声）', async () => {
    const db = makeDb({
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: new Prisma.Decimal('7000'), deletedAt: null },
      invoices: [{ id: 'I1', amount: new Prisma.Decimal('10000') }],
      allocations: [{ invoiceId: 'I1', appliedAmount: new Prisma.Decimal('3000') }],
    });
    const r = await recalculateCustomerCredit(db, { relationId: 'REL_1', reason: 'test' });
    expect(r).toEqual({ recalculated: false, before: 7000, after: 7000 });
    expect(db.creditLimit.update).not.toHaveBeenCalled();
    expect(db.creditLimitHistory.create).not.toHaveBeenCalled();
  });

  it('Decimal 精度：4 位小数比较不受浮点漂移影响（0.0001 级差额识别为变化）', async () => {
    const db = makeDb({
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: new Prisma.Decimal('100.0000'), deletedAt: null },
      invoices: [{ id: 'I1', amount: new Prisma.Decimal('100.0001') }],
      allocations: [],
    });
    const r = await recalculateCustomerCredit(db, { relationId: 'REL_1', reason: 'test' });
    expect(r?.recalculated).toBe(true);
    expect(r?.after).toBe(100.0001);
  });
});

describe('notifyCustomerCreditRecalc（挂接点安全性）', () => {
  it('invoiceId 只解析 type=Receivable 且挂客户档案的发票（Payable 跳过）', async () => {
    const db = makeDb({ invoiceById: { type: 'Payable', customerRelationId: 'REL_1' } });
    await notifyCustomerCreditRecalc(db, { invoiceId: 'I1', source: 'test' });
    expect(db.creditLimit.findFirst).not.toHaveBeenCalled();
  });

  it('invoiceId 解析到 Receivable → 执行重算', async () => {
    const db = makeDb({
      invoiceById: { type: 'Receivable', customerRelationId: 'REL_1' },
      creditLimit: { id: 'CL_1', relationId: 'REL_1', usedAmount: new Prisma.Decimal('0'), deletedAt: null },
      invoices: [{ id: 'I1', amount: new Prisma.Decimal('500') }],
      allocations: [],
    });
    await notifyCustomerCreditRecalc(db, { invoiceId: 'I1', source: 'test' });
    expect(db.creditLimit.update).toHaveBeenCalled();
  });

  it('内部异常不阻断主业务（catch + 不抛出）', async () => {
    const db = makeDb();
    db.creditLimit.findFirst = vi.fn().mockRejectedValue(new Error('DB_BOOM'));
    await expect(
      notifyCustomerCreditRecalc(db, { relationId: 'REL_1', source: 'test' }),
    ).resolves.toBeUndefined();
  });
});
