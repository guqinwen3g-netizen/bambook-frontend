/**
 * REQ2-02 资金日历回归测试（DR-044 净额口径锚点 + 分桶/敞口/泳道）
 *
 * 跨模块一致性铁律（验收计划 §4.4）锚点：
 *   Peerless INV-2026-PRL-0320（$84,000 PartiallyPaid 已核销 $50,000）
 *   → 资金日历 openAmount 必须等于账龄/对账单口径的 $34,000
 */
import { describe, expect, it, vi } from 'vitest';
import { getCashCalendar } from '../reportService';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makePrisma(opts: { invoices?: any[]; vouchers?: any[]; allocGroupBy?: any[]; voucherAllocGroupBy?: any[]; allocations?: any[] }) {
  return {
    invoice: {
      findMany: vi.fn().mockResolvedValue(opts.invoices ?? []),
    },
    paymentVoucher: {
      findMany: vi.fn().mockResolvedValue(opts.vouchers ?? []),
    },
    invoiceAllocation: {
      // 两次 groupBy：by invoiceId（发票净额）与 by voucherId（凭证未核销）按 by 字段分流
      groupBy: vi.fn().mockImplementation(async ({ by }: any) => {
        if (by?.includes('voucherId')) return opts.voucherAllocGroupBy ?? [];
        return opts.allocGroupBy ?? [];
      }),
      // 发票侧已核销自 2026-09-19 起走 findMany 真源（含贷项票抵扣），见 shared/invoiceAppliedSum
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        if (opts.allocations?.length) return opts.allocations;
        if (where?.voucherId?.in) {
          return (opts.voucherAllocGroupBy ?? []).map((g: any) => ({ voucherId: g.voucherId, appliedAmount: g._sum?.appliedAmount ?? 0 }));
        }
        return (opts.allocGroupBy ?? []).map((g: any) => ({ invoiceId: g.invoiceId, appliedAmount: g._sum?.appliedAmount ?? 0 }));
      }),
    },
  } as any;
}

const AS_OF = '2026-08-20';

describe('T2 顺带修：无到期日单据的口径统一（不可判逾期、不可排期，敞口保留）', () => {
  it('无 dueDate 的未结清应收 → 不进当日/未来排期、不进预测；外汇敞口保留', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'INV-NODUE', invoiceNumber: 'INV-NODUE', type: 'Receivable', amount: 5000, currency: 'USD', issueDate: '2026-03-01', dueDate: null, customerName: 'ACME', status: 'Issued' },
      ],
      allocGroupBy: [],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    // 旧口径 dueDate ?? issueDate 会把它当「当日到期」虚增逾期（2026-03-01 → 172 天）
    expect(r.todayActions).toHaveLength(0);
    expect(r.upcoming).toHaveLength(0);
    // 外汇敞口按未结余额口径保留（与到期日无关）
    const usd = r.forecast.find(f => f.currency === 'USD');
    expect(usd).toBeUndefined();
    const usdFx = r.fxExposure?.find?.((f: any) => f.currency === 'USD');
    if (usdFx) expect(usdFx.netReceivable).toBe(5000);
  });
});

describe('REQ2-02 getCashCalendar 资金日历', () => {
  it('净额锚点：Peerless $84,000 已核销 $50,000 → 逾期应收 $34,000（与账龄/对账单同口径）', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'INV-PRL', invoiceNumber: 'INV-2026-PRL-0320', type: 'Receivable', amount: 84000, currency: 'USD', issueDate: '2026-03-20', dueDate: '2026-04-20', customerName: 'Peerless', status: 'PartiallyPaid' },
      ],
      allocGroupBy: [{ invoiceId: 'INV-PRL', _sum: { appliedAmount: 50000 } }],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    expect(r.todayActions).toHaveLength(1);
    expect(r.todayActions[0].openAmount).toBe(34000);
    expect(r.todayActions[0].daysOverdue).toBe(122); // 2026-04-20 → 2026-08-20
    const usd = r.forecast.find(f => f.currency === 'USD')!;
    expect(usd.overdueInflow).toBe(34000);
    expect(usd.windowInflow).toBe(0);
    // 外汇敞口：USD 非本位币全额进入
    expect(r.fxExposure).toEqual([{ currency: 'USD', netReceivable: 34000, netPayable: 0 }]);
  });

  it('30 天窗口分桶：未来到期的应收 inflow / 应付 outflow / net', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'A', invoiceNumber: 'AR-1', type: 'Receivable', amount: 10000, currency: 'USD', issueDate: '2026-08-01', dueDate: '2026-09-01', customerName: 'ACME', status: 'Issued' },
        { id: 'B', invoiceNumber: 'AP-1', type: 'Payable', amount: 6000, currency: 'CNY', issueDate: '2026-08-01', dueDate: '2026-09-10', customerName: '工厂', status: 'Issued' },
        // 窗口外（35 天后）不进预测
        { id: 'C', invoiceNumber: 'AR-2', type: 'Receivable', amount: 99999, currency: 'USD', issueDate: '2026-08-01', dueDate: '2026-09-25', customerName: 'FAR', status: 'Issued' },
      ],
      allocGroupBy: [],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    expect(r.todayActions).toHaveLength(0);
    // upcoming 按 dueDate 升序：AR-1（09-01）在前，AP-1（09-10）在后
    expect(r.upcoming.map(u => u.invoiceNumber)).toEqual(['AR-1', 'AP-1']);
    const usd = r.forecast.find(f => f.currency === 'USD')!;
    expect(usd.windowInflow).toBe(10000);
    expect(usd.netWindow).toBe(10000);
    const cny = r.forecast.find(f => f.currency === 'CNY')!;
    expect(cny.windowOutflow).toBe(6000);
    expect(cny.netWindow).toBe(-6000);
    // CNY 本位币不进外汇敞口
    expect(r.fxExposure.find(f => f.currency === 'CNY')).toBeUndefined();
  });

  it('今日到期：daysOverdue=0 归入今日动作', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'D', invoiceNumber: 'DUE-TODAY', type: 'Receivable', amount: 500, currency: 'CNY', issueDate: '2026-07-20', dueDate: AS_OF, customerName: 'X', status: 'Issued' },
      ],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    expect(r.todayActions[0].daysOverdue).toBe(0);
  });

  it('全额核销发票排除（open<=0 不产生现金流事件）', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'E', invoiceNumber: 'PAID-1', type: 'Receivable', amount: 1000, currency: 'USD', issueDate: '2026-06-01', dueDate: '2026-07-01', customerName: 'Y', status: 'PartiallyPaid' },
      ],
      allocGroupBy: [{ invoiceId: 'E', _sum: { appliedAmount: 1000 } }],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    expect(r.todayActions).toHaveLength(0);
    expect(r.forecast).toHaveLength(0);
  });

  it('预收款泳道：未核销凭证余额按 voucherCategory 分组（DR-045 真源）', async () => {
    const prisma = makePrisma({
      invoices: [],
      vouchers: [
        { id: 'V1', amount: 8000, currency: 'USD', voucherCategory: 'advance' },
        { id: 'V2', amount: 3000, currency: 'USD', voucherCategory: 'advance' },
        { id: 'V3', amount: 5000, currency: 'CNY', voucherCategory: 'deposit' },
        { id: 'V4', amount: 2000, currency: 'CNY', voucherCategory: 'normal' }, // 将被全额核销
      ],
      voucherAllocGroupBy: [
        { voucherId: 'V1', _sum: { appliedAmount: 3000 } }, // 未核销 5000
        { voucherId: 'V2', _sum: { appliedAmount: 0 } },    // 未核销 3000
        { voucherId: 'V4', _sum: { appliedAmount: 2000 } }, // 全额核销 → 排除
      ],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    const advanceUsd = r.unappliedVouchers.find(u => u.voucherCategory === 'advance' && u.currency === 'USD')!;
    expect(advanceUsd.unapplied).toBe(8000);
    expect(advanceUsd.count).toBe(2);
    const depositCny = r.unappliedVouchers.find(u => u.voucherCategory === 'deposit')!;
    expect(depositCny.unapplied).toBe(5000);
    expect(r.unappliedVouchers.find(u => u.voucherCategory === 'normal')).toBeUndefined();
  });

  it('T2 顺带修（口径翻转）：dueDate 缺失不再回退 issueDate 判当日到期（旧口径虚增逾期，已废止）', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'F', invoiceNumber: 'NO-DUE', type: 'Receivable', amount: 100, currency: 'CNY', issueDate: '2026-08-01', dueDate: null, customerName: 'Z', status: 'Issued' },
      ],
    });
    const r = await getCashCalendar(prisma, { asOf: AS_OF, days: 30 });
    // 旧口径：dueDate ?? issueDate → 无到期日被当「开票即当日到期」虚增逾期。
    // 新口径：无到期日 = 不可排期，不进当日/未来排期（与催款侧「永不进催款」一致）。
    expect(r.todayActions).toHaveLength(0);
    expect(r.upcoming).toHaveLength(0);
  });
});
