/**
 * W-B 波次 · P2-7 多币种应收应付对账 — fxReconciliationService 回归测试
 *
 * 场景真源：跨域契约表断层②拍板「币种统一 Order.currency」后的汇率链显式化
 * （docs/README.md W-0 节；FxRateLock 无 status/amount 字段 → active=deletedAt null、
 * 按 (orderId, currency) 整单覆盖）。
 *
 * 覆盖：
 *   1. 三段汇率链差异计算（A 开票 vs 市场 / B 收付 vs 开票 → 损益 / C 结汇 vs 收付 → 损益）
 *   2. 锁汇优先（active 锁 → 期望汇率取锁定价，差异记 info；软删锁失效回退市场）
 *   3. 缺汇率快照 critical / 无市场档案 info
 *   4. 多币种汇总（invoicedByCurrency 分组 + 锁汇覆盖金额）
 *   5. computeFxGainLoss 符号口径（Receivable/Payable 双向）
 *   6. findActiveFxLock
 *   7. 口径统一：getFxGainLoss 走同一汇率链（B 段符号一致 + C 段结汇行 + 锁汇覆盖标记）
 */
import { describe, expect, it } from 'vitest';
import {
  computeFxGainLoss,
  findActiveFxLock,
  reconcileOrderFx,
} from '../fxReconciliationService';
import { getFxGainLoss } from '../reportService';

/** 内存 prisma：覆盖汇率链三段 + 报表统一口径消费的查询面 */
function makePrisma(seed: {
  orders?: any[];
  ioas?: any[];
  invoices?: any[];
  locks?: any[];
  allocations?: any[];
  vouchers?: any[];
  settlements?: any[];
  exchangeRates?: any[];
} = {}) {
  const state = {
    orders: seed.orders ?? [],
    ioas: seed.ioas ?? [],
    invoices: seed.invoices ?? [],
    locks: seed.locks ?? [],
    allocations: seed.allocations ?? [],
    vouchers: seed.vouchers ?? [],
    settlements: seed.settlements ?? [],
    exchangeRates: seed.exchangeRates ?? [],
  };
  const prisma: any = {
    order: {
      findFirst: async ({ where }: any) =>
        state.orders.find(o => o.deletedAt == null && (!where?.id || o.id === where.id)) ?? null,
    },
    invoiceOrderAllocation: {
      findMany: async ({ where }: any = {}) =>
        state.ioas.filter(a => a.deletedAt == null && (!where?.orderId || a.orderId === where.orderId)),
    },
    invoice: {
      findMany: async ({ where }: any = {}) =>
        state.invoices.filter(i =>
          i.deletedAt == null
          && (!where?.id?.in || where.id.in.includes(i.id))
          && (!where?.orderId || i.orderId === where.orderId)
          && (!where?.type || i.type === where.type)),
    },
    fxRateLock: {
      findMany: async ({ where }: any = {}) =>
        state.locks.filter(l => {
          if (l.deletedAt != null) return false;
          if (where?.orderId?.in) return where.orderId.in.includes(l.orderId);
          if (where?.orderId) return l.orderId === where.orderId;
          return true;
        }),
      findFirst: async ({ where }: any = {}) =>
        state.locks.find(l =>
          l.deletedAt == null
          && (!where?.orderId || l.orderId === where.orderId)
          && (!where?.currency || l.currency === where.currency)) ?? null,
    },
    invoiceAllocation: {
      findMany: async ({ where }: any = {}) =>
        state.allocations.filter(a =>
          (!where?.invoiceId?.in || where.invoiceId.in.includes(a.invoiceId))
          && (!where?.appliedDate?.gte || a.appliedDate >= where.appliedDate.gte)
          && (!where?.appliedDate?.lte || a.appliedDate <= where.appliedDate.lte)),
    },
    paymentVoucher: {
      findMany: async ({ where }: any = {}) =>
        state.vouchers.filter(v => !where?.id?.in || where.id.in.includes(v.id)),
    },
    fxSettlement: {
      findMany: async ({ where }: any = {}) =>
        state.settlements.filter(s =>
          s.deletedAt == null
          && (!where?.orderId || s.orderId === where.orderId)
          && (!where?.voucherId?.in || where.voucherId.in.includes(s.voucherId))
          && (!where?.settleDate?.gte || s.settleDate >= where.settleDate.gte)
          && (!where?.settleDate?.lte || s.settleDate <= where.settleDate.lte)),
    },
    exchangeRate: {
      findFirst: async ({ where }: any = {}) => {
        let rows = state.exchangeRates.filter(r => !where?.currency || r.currency === where.currency);
        if (where?.effectiveDate?.lte) rows = rows.filter(r => r.effectiveDate <= where.effectiveDate.lte);
        rows = [...rows].sort((a, b) =>
          b.effectiveDate.localeCompare(a.effectiveDate) || Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
        return rows[0] ?? null;
      },
    },
  };
  return prisma;
}

// ── 共享夹具：USD 订单 + 发票(7.0) + 市场档案(7.2@06-30 / 7.25@07-15) + 收款(7.1) + 结汇(7.15) ──
const baseOrder = { id: 'ORD1', currency: 'USD', deletedAt: null };
const usdInvoice = {
  id: 'INV1', invoiceNumber: 'INV-001', type: 'Receivable', status: 'PartiallyPaid',
  amount: '10000', currency: 'USD', baseCurrency: 'CNY', exchangeRate: '7.0',
  issueDate: '2026-07-01', orderId: 'ORD1', deletedAt: null,
};
const marketRates = [
  { id: 'FXR1', currency: 'USD', rate: '7.20', effectiveDate: '2026-06-30', createdAt: 1n },
  { id: 'FXR2', currency: 'USD', rate: '7.25', effectiveDate: '2026-07-15', createdAt: 2n }, // 开票日后，A 段不可取
];
const usdVoucher = {
  id: 'PAY1', voucherNumber: 'PAY-001', type: 'Receipt', amount: '6000', currency: 'USD',
  exchangeRate: '7.10', baseCurrency: 'CNY', paymentDate: '2026-07-10', orderId: 'ORD1', deletedAt: null,
};
const usdAlloc = { id: 'AL1', invoiceId: 'INV1', voucherId: 'PAY1', appliedAmount: '6000', appliedDate: '2026-07-10' };
const usdSettlement = {
  id: 'FXS1', settlementNumber: 'FXS-001', voucherId: 'PAY1', orderId: 'ORD1',
  settleDate: '2026-07-20', foreignAmount: '3000', currency: 'USD', fxRate: '7.15',
  cnyAmount: '21450', deletedAt: null,
};
const usdIoa = { id: 'IOA1', invoiceId: 'INV1', orderId: 'ORD1', allocatedAmount: null, deletedAt: null };

function seedChain(overrides: Parameters<typeof makePrisma>[0] = {}) {
  return makePrisma({
    orders: [baseOrder],
    ioas: [usdIoa],
    invoices: [usdInvoice],
    allocations: [usdAlloc],
    vouchers: [usdVoucher],
    settlements: [usdSettlement],
    exchangeRates: marketRates,
    ...overrides,
  });
}

describe('reconcileOrderFx — 三段汇率链差异计算', () => {
  it('A 段：开票汇率 vs 市场汇率（effectiveDate ≤ issueDate 最近一条），>2% 记 warning', async () => {
    const prisma = seedChain();
    const r = await reconcileOrderFx(prisma, 'ORD1');
    expect(r).not.toBeNull();
    expect(r!.segments.map(s => s.stage)).toEqual(['order_to_invoice', 'invoice_to_payment', 'payment_to_settlement']);

    const segA = r!.segments[0];
    // 期望汇率 = 7.20（06-30 ≤ 07-01 最近）；07-15 的 7.25 不可取
    expect(segA.expectedRate).toBe(7.2);
    expect(segA.rateSource).toBe('market');
    expect(segA.documentRate).toBe(7);
    expect(segA.variance).toBe(-0.2);
    expect(segA.gainLossCny).toBeNull(); // A 段未实现

    const discA = r!.fxDiscrepancies.find(d => d.type === 'order_to_invoice');
    expect(discA).toBeDefined();
    expect(discA!.severity).toBe('warning'); // |−2.78%| > 2% 疑录入错误
    expect(discA!.fromCurrency).toBe('USD');
    expect(discA!.toCurrency).toBe('CNY');
    expect(discA!.expectedRate).toBe(7.2);
    expect(discA!.actualRate).toBe(7);
    expect(discA!.variance).toBe(-0.2);
  });

  it('B 段：收付汇率 vs 开票汇率 → 已实现损益 6000×(7.1−7.0)=+600，阈值内记 info', async () => {
    const prisma = seedChain();
    const r = await reconcileOrderFx(prisma, 'ORD1');
    const segB = r!.segments.find(s => s.stage === 'invoice_to_payment')!;
    expect(segB.documentNumber).toBe('PAY-001');
    expect(segB.documentRate).toBe(7.1);
    expect(segB.expectedRate).toBe(7);
    expect(segB.rateSource).toBe('upstream');
    expect(segB.gainLossCny).toBe(600);

    const discB = r!.fxDiscrepancies.find(d => d.type === 'invoice_to_payment');
    expect(discB).toBeDefined();
    expect(discB!.severity).toBe('info'); // 1.43% ≤ 5%
    expect(discB!.gainLossCny).toBe(600);
  });

  it('C 段：结汇汇率 vs 收付汇率 → 已实现损益 3000×(7.15−7.1)=+150', async () => {
    const prisma = seedChain();
    const r = await reconcileOrderFx(prisma, 'ORD1');
    const segC = r!.segments.find(s => s.stage === 'payment_to_settlement')!;
    expect(segC.documentNumber).toBe('FXS-001');
    expect(segC.documentRate).toBe(7.15);
    expect(segC.expectedRate).toBe(7.1);
    expect(segC.gainLossCny).toBe(150);

    // 已实现损益合计 = B + C
    expect(r!.realizedGainLossCny).toBe(750);
  });

  it('汇率一致（无差异）→ 不记 discrepancy，segment 仍保留对照行', async () => {
    const prisma = seedChain({
      invoices: [{ ...usdInvoice, exchangeRate: '7.2' }],  // 与市场一致
      vouchers: [{ ...usdVoucher, exchangeRate: '7.2' }],  // 与开票一致
      settlements: [{ ...usdSettlement, fxRate: '7.2' }],  // 与收付一致
    });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    expect(r!.segments).toHaveLength(3);
    expect(r!.fxDiscrepancies).toEqual([]);
    expect(r!.realizedGainLossCny).toBe(0);
  });

  it('缺汇率快照：发票缺 → A critical；凭证缺 → B critical 且 C critical', async () => {
    const prisma = seedChain({
      invoices: [{ ...usdInvoice, exchangeRate: null }],
    });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    const discA = r!.fxDiscrepancies.find(d => d.type === 'order_to_invoice');
    expect(discA!.severity).toBe('critical');
    expect(discA!.actualRate).toBeNull();
    // B 段上游缺失由 A 段覆盖，不重复记
    expect(r!.fxDiscrepancies.find(d => d.type === 'invoice_to_payment')).toBeUndefined();

    const prisma2 = seedChain({
      vouchers: [{ ...usdVoucher, exchangeRate: null }],
    });
    const r2 = await reconcileOrderFx(prisma2, 'ORD1');
    expect(r2!.fxDiscrepancies.find(d => d.type === 'invoice_to_payment')!.severity).toBe('critical');
    expect(r2!.fxDiscrepancies.find(d => d.type === 'payment_to_settlement')!.severity).toBe('critical');
    expect(r2!.realizedGainLossCny).toBe(0); // 双边缺快照无法算损益
  });

  it('无市场汇率档案 → A 段 info（无法比对，不阻塞）', async () => {
    const prisma = seedChain({ exchangeRates: [] });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    const discA = r!.fxDiscrepancies.find(d => d.type === 'order_to_invoice');
    expect(discA!.severity).toBe('info');
    expect(discA!.expectedRate).toBeNull();
    expect(discA!.message).toContain('无市场汇率档案');
  });

  it('纯 CNY 订单 → 无汇率链语义（segments 空）', async () => {
    const prisma = makePrisma({
      orders: [{ id: 'ORD9', currency: 'CNY', deletedAt: null }],
      invoices: [{ ...usdInvoice, id: 'INV9', currency: 'CNY', exchangeRate: '1', orderId: 'ORD9' }],
      ioas: [],
    });
    const r = await reconcileOrderFx(prisma, 'ORD9');
    expect(r!.segments).toEqual([]);
    expect(r!.fxDiscrepancies).toEqual([]);
    expect(r!.invoicedByCurrency).toEqual([]);
  });

  it('订单不存在返回 null', async () => {
    const prisma = makePrisma({});
    expect(await reconcileOrderFx(prisma, 'NOPE')).toBeNull();
  });
});

describe('reconcileOrderFx — 锁汇优先', () => {
  const lock = { id: 'FXL1', orderId: 'ORD1', currency: 'USD', rate: '7.30', lockedAt: 1n, deletedAt: null };

  it('active 锁 → 期望汇率取锁定价而非市场价，差异记 info（设计内）', async () => {
    const prisma = seedChain({ locks: [lock] });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    expect(r!.locks).toHaveLength(1);
    expect(r!.locks[0]).toMatchObject({ id: 'FXL1', currency: 'USD', rate: 7.3 });

    const segA = r!.segments[0];
    expect(segA.expectedRate).toBe(7.3); // 锁定价，不是市场 7.20
    expect(segA.rateSource).toBe('locked');

    const discA = r!.fxDiscrepancies.find(d => d.type === 'order_to_invoice');
    // 7.0 vs 7.3 偏差 −4.11% 远超 2% 阈值，但锁汇覆盖 → info
    expect(discA!.severity).toBe('info');
    expect(discA!.locked).toBe(true);
    expect(discA!.message).toContain('锁汇');

    // B/C 段同样锁汇标记 + info
    const discB = r!.fxDiscrepancies.find(d => d.type === 'invoice_to_payment');
    expect(discB!.severity).toBe('info');
    expect(discB!.locked).toBe(true);

    // 锁汇不改变单据快照口径：已实现损益仍为 750
    expect(r!.realizedGainLossCny).toBe(750);
    // 锁汇覆盖金额 = 全部 USD 应收
    expect(r!.invoicedByCurrency).toEqual([{ currency: 'USD', amount: 10000, lockedAmount: 10000 }]);
  });

  it('软删锁失效 → 回退市场汇率（warning 分级恢复）', async () => {
    const prisma = seedChain({ locks: [{ ...lock, deletedAt: 2n }] });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    expect(r!.locks).toHaveLength(0);
    expect(r!.segments[0].expectedRate).toBe(7.2);
    expect(r!.segments[0].rateSource).toBe('market');
    expect(r!.fxDiscrepancies.find(d => d.type === 'order_to_invoice')!.severity).toBe('warning');
  });

  it('锁币种不匹配（锁 EUR / 发票 USD）→ 不覆盖', async () => {
    const prisma = seedChain({ locks: [{ ...lock, currency: 'EUR' }] });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    expect(r!.locks).toHaveLength(1); // 锁仍列出（订单持有 EUR 锁的事实）
    expect(r!.segments[0].rateSource).toBe('market'); // USD 发票不被 EUR 锁覆盖
    expect(r!.invoicedByCurrency[0].lockedAmount).toBe(0);
  });
});

describe('reconcileOrderFx — 多币种汇总', () => {
  it('USD+EUR 双币种发票分组；仅 USD 锁汇 → 覆盖金额按币种独立', async () => {
    const eurInvoice = {
      ...usdInvoice, id: 'INV2', invoiceNumber: 'INV-002', currency: 'EUR',
      exchangeRate: '7.8', amount: '5000',
    };
    const prisma = makePrisma({
      orders: [baseOrder],
      ioas: [usdIoa, { ...usdIoa, id: 'IOA2', invoiceId: 'INV2' }],
      invoices: [usdInvoice, eurInvoice],
      locks: [{ id: 'FXL1', orderId: 'ORD1', currency: 'USD', rate: '7.30', lockedAt: 1n, deletedAt: null }],
      exchangeRates: [...marketRates, { id: 'FXR3', currency: 'EUR', rate: '7.9', effectiveDate: '2026-06-30', createdAt: 1n }],
    });
    const r = await reconcileOrderFx(prisma, 'ORD1');
    expect(r!.invoicedByCurrency).toEqual([
      { currency: 'EUR', amount: 5000, lockedAmount: 0 },
      { currency: 'USD', amount: 10000, lockedAmount: 10000 },
    ]);
    // 两个币种各一条 A 段对照行
    const segAs = r!.segments.filter(s => s.stage === 'order_to_invoice');
    expect(segAs).toHaveLength(2);
    expect(segAs.find(s => s.currency === 'EUR')!.expectedRate).toBe(7.9);
    expect(segAs.find(s => s.currency === 'USD')!.rateSource).toBe('locked');
  });
});

describe('computeFxGainLoss — 损益符号唯一真源', () => {
  it('Receivable：下游汇率高 = 收益；低 = 损失', () => {
    expect(computeFxGainLoss({ side: 'Receivable', foreignAmount: 1000, fromRate: 7.0, toRate: 7.2 })).toBe(200);
    expect(computeFxGainLoss({ side: 'Receivable', foreignAmount: 1000, fromRate: 7.2, toRate: 7.0 })).toBe(-200);
  });

  it('Payable：付汇汇率低 = 收益；高 = 损失', () => {
    expect(computeFxGainLoss({ side: 'Payable', foreignAmount: 2000, fromRate: 7.0, toRate: 6.8 })).toBe(400);
    expect(computeFxGainLoss({ side: 'Payable', foreignAmount: 2000, fromRate: 6.8, toRate: 7.0 })).toBe(-400);
  });
});

describe('findActiveFxLock', () => {
  it('active 锁返回锁定信息；软删/币种不匹配返回 null', async () => {
    const prisma = makePrisma({
      locks: [
        { id: 'FXL1', orderId: 'ORD1', currency: 'USD', rate: '7.30', deletedAt: null },
        { id: 'FXL2', orderId: 'ORD1', currency: 'EUR', rate: '7.90', deletedAt: 1n },
      ],
    });
    expect(await findActiveFxLock(prisma, 'ORD1', 'USD')).toMatchObject({ id: 'FXL1', rate: 7.3 });
    expect(await findActiveFxLock(prisma, 'ORD1', 'EUR')).toBeNull(); // 已软删
    expect(await findActiveFxLock(prisma, 'ORD1', 'HKD')).toBeNull(); // 无此币种锁
  });
});

describe('口径统一 — getFxGainLoss 走同一汇率链', () => {
  const invR = {
    id: 'INV_R', invoiceNumber: 'INV-R', type: 'Receivable', amount: 10000,
    currency: 'USD', baseCurrency: 'CNY', exchangeRate: 7.0, orderId: 'ORD1', deletedAt: null,
  };
  const vocUp = { id: 'VOC_UP', voucherNumber: 'PAY-UP', exchangeRate: 7.2, deletedAt: null };

  it('B 段核销行（符号与 computeFxGainLoss 一致）+ C 段结汇行 + 行级锁汇标记 + 覆盖汇总', async () => {
    const prisma = makePrisma({
      invoices: [invR],
      vouchers: [vocUp],
      allocations: [{ id: 'AL1', invoiceId: 'INV_R', voucherId: 'VOC_UP', appliedAmount: 1000, appliedDate: '2026-07-01' }],
      settlements: [{
        id: 'FXS1', settlementNumber: 'FXS-001', voucherId: 'VOC_UP', orderId: 'ORD1',
        settleDate: '2026-07-05', foreignAmount: 400, currency: 'USD', fxRate: 7.3, deletedAt: null,
      }],
      locks: [{ id: 'FXL1', orderId: 'ORD1', currency: 'USD', rate: 7.1, deletedAt: null }],
    });
    const report = await getFxGainLoss(prisma, {});
    expect(report.rows).toHaveLength(2);

    // B 段：1000 × (7.2 − 7.0) = +200（与旧口径数值一致，符号真源统一）
    const segB = report.rows.find(r => r.segment === 'invoice_to_payment')!;
    expect(segB).toMatchObject({ invoiceNumber: 'INV-R', gainLoss: 200, lockProtected: true });

    // C 段：400 × (7.3 − 7.2) = +40；上游单据 = 收款凭证
    const segC = report.rows.find(r => r.segment === 'payment_to_settlement')!;
    expect(segC).toMatchObject({
      invoiceNumber: 'PAY-UP', voucherNumber: 'FXS-001',
      invoiceRate: 7.2, voucherRate: 7.3, gainLoss: 40, lockProtected: true,
    });

    expect(report.totalGainLoss).toBe(240);
    expect(report.lockCoverage).toEqual([
      { currency: 'USD', totalAmount: 10000, lockedAmount: 10000, coveragePct: 1 },
    ]);
  });

  it('无锁汇订单 → lockProtected=false，coveragePct=0；结汇日期区间过滤生效', async () => {
    const prisma = makePrisma({
      invoices: [invR],
      vouchers: [vocUp],
      allocations: [{ id: 'AL1', invoiceId: 'INV_R', voucherId: 'VOC_UP', appliedAmount: 1000, appliedDate: '2026-07-01' }],
      settlements: [{
        id: 'FXS1', settlementNumber: 'FXS-001', voucherId: 'VOC_UP', orderId: 'ORD1',
        settleDate: '2026-08-05', foreignAmount: 400, currency: 'USD', fxRate: 7.3, deletedAt: null,
      }],
    });
    const report = await getFxGainLoss(prisma, {});
    expect(report.rows.every(r => !r.lockProtected)).toBe(true);
    expect(report.lockCoverage).toEqual([
      { currency: 'USD', totalAmount: 10000, lockedAmount: 0, coveragePct: 0 },
    ]);

    // 7 月窗口：仅 B 段核销行（C 段结汇在 8 月）
    const july = await getFxGainLoss(prisma, { from: '2026-07-01', to: '2026-07-31' });
    expect(july.rows).toHaveLength(1);
    expect(july.rows[0].segment).toBe('invoice_to_payment');
  });
});
