/**
 * Phase C1 — 经营驾驶舱聚合服务单元测试
 *
 * 覆盖：
 *   - 销售业绩排行：salesPerson × currency 分组 + contractAmount ?? quoteAmount 口径 + 未分配兜底
 *   - 客户贡献度：同币种内占比 + 多币种不混合
 *   - 订单毛利表：收入/成本口径优先级 + 跨币种排除 + 亏损靠前排序 + 合计
 *   - 回款口径（2026-09-02 切换）：核销链真源 Σ InvoiceAllocation.appliedAmount
 *     （Receipt × Receivable），IOA 分摊优先 / orderId 直挂兜底 / 跨币种不并入
 *   - 应收应付预警：逾期桶聚合 + Top5 截断
 *   - 汇率损益汇总：totalGainLoss 透传
 *   - 日期区间：dueDate 字典序过滤
 */

import { describe, expect, it, vi } from 'vitest';
import { getBusinessCockpit } from '../dashboardService';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makePrisma(opts: {
  orders?: any[];
  invoices?: any[];
  vouchers?: any[];
  allocations?: any[];
  allocGroupBy?: any[];
  ioa?: any[]; // InvoiceOrderAllocation（回款/开票分摊链）
  devCases?: any[];
  fxRates?: any[];
  settlements?: any[]; // FxSettlement（P2-7 汇率链 C 段）
  locks?: any[];       // FxRateLock（P2-7 锁汇索引）
}) {
  return {
    order: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.orders ?? [];
        if (where?.dueDate?.gte) rows = rows.filter(r => r.dueDate >= where.dueDate.gte);
        if (where?.dueDate?.lte) rows = rows.filter(r => r.dueDate <= where.dueDate.lte);
        if (where?.dueDate?.lt) rows = rows.filter(r => r.dueDate < where.dueDate.lt);
        return rows;
      }),
    },
    invoice: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.invoices ?? [];
        if (where?.id?.in) return rows.filter(r => where.id.in.includes(r.id));
        if (where?.type) rows = rows.filter(r => r.type === where.type);
        if (where?.status?.not) rows = rows.filter(r => r.status !== where.status.not);
        return rows;
      }),
    },
    paymentVoucher: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.vouchers ?? [];
        if (where?.id?.in) return rows.filter(r => where.id.in.includes(r.id));
        if (where?.type) rows = rows.filter(r => r.type === where.type);
        return rows;
      }),
    },
    invoiceAllocation: {
      groupBy: vi.fn().mockResolvedValue(opts.allocGroupBy ?? []),
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        // 兼容旧「按 invoiceId 汇总」夹具（allocGroupBy 形态 → 明细形态）
        let rows = opts.allocations?.length
          ? opts.allocations
          : (opts.allocGroupBy ?? []).map((g: any) => ({ invoiceId: g.invoiceId, voucherId: g.voucherId, appliedAmount: g._sum?.appliedAmount ?? 0 }));
        if (where?.appliedDate?.gte) rows = rows.filter(r => r.appliedDate >= where.appliedDate.gte);
        if (where?.appliedDate?.lte) rows = rows.filter(r => r.appliedDate <= where.appliedDate.lte);
        return rows;
      }),
    },
    invoiceOrderAllocation: {
      findMany: vi.fn().mockResolvedValue(opts.ioa ?? []),
    },
    developmentCase: {
      findMany: vi.fn().mockResolvedValue(opts.devCases ?? []),
    },
    exchangeRate: {
      findMany: vi.fn().mockResolvedValue(opts.fxRates ?? []),
    },
    // P2-7：getFxGainLoss 统一汇率链后新增 C 段结汇查询 + 锁汇索引（驾驶舱经由 getBusinessCockpit 消费）
    fxSettlement: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = (opts.settlements ?? []).filter((r: any) => r.deletedAt == null);
        if (where?.settleDate?.gte) rows = rows.filter((r: any) => r.settleDate >= where.settleDate.gte);
        if (where?.settleDate?.lte) rows = rows.filter((r: any) => r.settleDate <= where.settleDate.lte);
        return rows;
      }),
    },
    fxRateLock: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = (opts.locks ?? []).filter((r: any) => r.deletedAt == null);
        if (where?.orderId?.in) rows = rows.filter((r: any) => where.orderId.in.includes(r.orderId));
        return rows;
      }),
    },
  } as any;
}

function makeOrder(over: Partial<any> = {}) {
  // ★ 订单金额真源已改为「以明细行为准」（Kevin 2026-09-18 拍板）：
  //   mock 不带 lines 时，真源取 totalNet（≡ Σ明细行 netValue）。
  //   故这里显式给 totalNet，让它**承接原先 contractAmount 承担的「订单金额」角色**，
  //   断言值不变、但验的是新口径；没给就由 contractAmount ?? quoteAmount 推导。
  const base = {
    id: 'O1', poNumber: 'PO-1', customer: 'ACME', product: 'T-Shirt',
    salesPerson: 'Alice', dueDate: '2026-08-01', status: 'Production', quantity: 100,
    currency: 'USD', salesCurrency: 'USD', purchaseCurrency: 'USD',
    quoteAmount: 1000, contractAmount: 1200, shipmentAmount: null,
    actualPaymentAmount: 600, purchasePrice: null, supplierInvoiceAmount: 800,
    customerRelationId: 'REL_A',
  };
  const merged = { ...base, ...over };
  return {
    ...merged,
    totalNet: merged.totalNet ?? merged.contractAmount ?? merged.quoteAmount,
  };
}

describe('getBusinessCockpit — 销售业绩排行', () => {
  it('groups by salesPerson × currency with contractAmount priority and collected sum', async () => {
    // 回款口径（2026-09-02）：collected 来自核销链（Receipt × Receivable × IOA 分摊），
    // 不再读 Order.actualPaymentAmount（69/69 NULL 的手工字段）
    const prisma = makePrisma({
      orders: [
        makeOrder(),
        makeOrder({ id: 'O2', salesPerson: 'Alice', contractAmount: null, quoteAmount: 500, actualPaymentAmount: null }),
        makeOrder({ id: 'O3', salesPerson: 'Bob', contractAmount: 3000, quoteAmount: 3000, actualPaymentAmount: null }),
        makeOrder({ id: 'O4', salesPerson: '  ', contractAmount: 200, quoteAmount: 200, actualPaymentAmount: 0 }),
      ],
      invoices: [
        { id: 'INV1', orderId: 'O1', amount: 1200, currency: 'USD', type: 'Receivable', status: 'Issued' },
        { id: 'INV3', orderId: 'O3', amount: 3000, currency: 'USD', type: 'Receivable', status: 'PartiallyPaid' },
      ],
      ioa: [
        { invoiceId: 'INV1', orderId: 'O1', allocatedAmount: 1200 },
        { invoiceId: 'INV3', orderId: 'O3', allocatedAmount: 3000 },
      ],
      vouchers: [{ id: 'V1', type: 'Receipt' }, { id: 'V3', type: 'Receipt' }],
      allocations: [
        { invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 600 },
        { invoiceId: 'INV3', voucherId: 'V3', appliedAmount: 1000 },
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard).toEqual([
      { salesPerson: 'Bob', currency: 'USD', orderCount: 1, salesAmount: 3000, collectedAmount: 1000, collectionRate: 0.3333 },
      { salesPerson: 'Alice', currency: 'USD', orderCount: 2, salesAmount: 1700, collectedAmount: 600, collectionRate: 0.3529 },
      { salesPerson: '未分配', currency: 'USD', orderCount: 1, salesAmount: 200, collectedAmount: 0, collectionRate: 0 },
    ]);
  });

  it('splits rows by currency without conversion', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder(),
        makeOrder({ id: 'O2', salesCurrency: 'EUR', contractAmount: 900 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard).toHaveLength(2);
    expect(cockpit.salesLeaderboard.map(r => r.currency).sort()).toEqual(['EUR', 'USD']);
  });
});

describe('getBusinessCockpit — 客户贡献度', () => {
  it('computes share within same currency only', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ contractAmount: 3000 }),
        makeOrder({ id: 'O2', customer: 'BETA', customerRelationId: 'REL_B', contractAmount: 1000 }),
        makeOrder({ id: 'O3', customer: 'GMBH', customerRelationId: 'REL_C', salesCurrency: 'EUR', contractAmount: 500 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const acme = cockpit.customerContribution.find(r => r.customer === 'ACME')!;
    const beta = cockpit.customerContribution.find(r => r.customer === 'BETA')!;
    const gmbh = cockpit.customerContribution.find(r => r.customer === 'GMBH')!;
    expect(acme.share).toBe(0.75);
    expect(beta.share).toBe(0.25);
    expect(gmbh.share).toBe(1); // EUR 币种内独占
  });
});

describe('getBusinessCockpit — 订单毛利表', () => {
  it('uses shipmentAmount > contractAmount > quoteAmount revenue priority', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ shipmentAmount: 1500 }), // 收入取 shipmentAmount
        makeOrder({ id: 'O2', shipmentAmount: null, contractAmount: 1200 }), // 取 contractAmount
        makeOrder({ id: 'O3', shipmentAmount: null, contractAmount: null, quoteAmount: 900 }), // 取 quoteAmount
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const byId = new Map(cockpit.orderMargins.rows.map(r => [r.orderId, r]));
    expect(byId.get('O1')!.revenue).toBe(1500);
    expect(byId.get('O2')!.revenue).toBe(1200);
    expect(byId.get('O3')!.revenue).toBe(900);
  });

  it('falls back to purchasePrice × quantity when supplierInvoiceAmount missing', async () => {
    const prisma = makePrisma({
      orders: [makeOrder({ supplierInvoiceAmount: null, purchasePrice: 5, quantity: 100 })],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const row = cockpit.orderMargins.rows[0];
    expect(row.cost).toBe(500);
    expect(row.margin).toBe(700); // 1200 - 500
    expect(row.marginRate).toBe(0.5833);
  });

  // ★★ B2（2026-09-18）：跨币种**不再**一律排除 —— 折算后照算。
  //   旧行为（margin=null + 不进合计）保留在「汇率缺失」这一支：猜汇率比没有更危险。
  it('跨币种 + 有汇率 → 折算后算毛利，并计入合计', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ purchaseCurrency: 'CNY', supplierInvoiceAmount: 5000 }), // 销售 USD / 采购 CNY
        makeOrder({ id: 'O2', supplierInvoiceAmount: 800 }), // 同币种正常
      ],
      fxRates: [{ currency: 'USD', rate: 7.1, effectiveDate: '2026-08-01' }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const cross = cockpit.orderMargins.rows.find(r => r.orderId === 'O1')!;
    expect(cross.crossCurrency).toBe(true);
    // 成本 5000 CNY ÷ 7.1 = 704.2253... USD
    expect(cross.costInSalesCurrency).toBe(704.2254);
    expect(cross.fxRate).toBeCloseTo(1 / 7.1, 6); // 1 CNY = ? USD
    expect(cross.fxRateSource).toBe('market');
    expect(cross.margin).toBe(495.7746); // 1200 − 704.2254
    // 两单都进合计（跨币种那单按折后成本计）
    expect(cockpit.orderMargins.totals).toHaveLength(1);
    expect(cockpit.orderMargins.totals[0].orderCount).toBe(2);
    expect(cockpit.orderMargins.totals[0].cost).toBe(1504.2254); // 704.2254 + 800
    expect(cockpit.orderMargins.excludedCount).toBe(0);
  });

  it('跨币种但**无汇率档案** → 不折算、不猜（margin=null，不进合计）', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ purchaseCurrency: 'CNY', supplierInvoiceAmount: 5000 }),
        makeOrder({ id: 'O2', supplierInvoiceAmount: 800 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const cross = cockpit.orderMargins.rows.find(r => r.orderId === 'O1')!;
    expect(cross.crossCurrency).toBe(true);
    expect(cross.costInSalesCurrency).toBeNull();
    expect(cross.margin).toBeNull();
    expect(cockpit.orderMargins.totals).toHaveLength(1);
    expect(cockpit.orderMargins.totals[0].orderCount).toBe(1);
    expect(cockpit.orderMargins.excludedCount).toBe(1);
  });

  it('锁汇优先于市场汇率（fxRateSource=lock）', async () => {
    const prisma = makePrisma({
      orders: [makeOrder({ purchaseCurrency: 'CNY', supplierInvoiceAmount: 7100 })],
      fxRates: [{ currency: 'USD', rate: 7.1, effectiveDate: '2026-08-01' }],
      locks: [{ id: 'L1', orderId: 'O1', currency: 'USD', rate: 7.3, deletedAt: null }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const row = cockpit.orderMargins.rows.find(r => r.orderId === 'O1')!;
    // 锁定 7.3 ⇒ 7100 CNY ÷ 7.3 = 972.6027 USD（不是按市场 7.1 的 1000）
    expect(row.costInSalesCurrency).toBe(972.6027);
    expect(row.fxRateSource).toBe('lock');
    expect(row.margin).toBe(227.3973); // 1200 − 972.6027
  });

  it('sorts loss-making orders first, null-margin last by revenue desc', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'WIN', contractAmount: 2000, supplierInvoiceAmount: 800 }), // +1200
        makeOrder({ id: 'LOSS', contractAmount: 1000, supplierInvoiceAmount: 1300 }), // -300
        makeOrder({ id: 'NOCOST', contractAmount: 5000, supplierInvoiceAmount: null, purchasePrice: null }), // null
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.orderMargins.rows.map(r => r.orderId)).toEqual(['LOSS', 'WIN', 'NOCOST']);
  });

  it('respects marginRowLimit', async () => {
    const prisma = makePrisma({
      orders: Array.from({ length: 10 }, (_, i) => makeOrder({ id: `O${i}` })),
    });
    const cockpit = await getBusinessCockpit(prisma, { marginRowLimit: 3 });
    expect(cockpit.orderMargins.rows).toHaveLength(3);
  });
});

describe('getBusinessCockpit — 应收应付预警', () => {
  it('aggregates overdue buckets and returns top-5 alert rows', async () => {
    const invoices = Array.from({ length: 7 }, (_, i) => ({
      id: `INV${i}`, invoiceNumber: `INV-${i}`, amount: 100 * (i + 1), currency: 'USD',
      issueDate: '2026-01-01', dueDate: '2026-02-01', // 已逾期（asOf 默认今天 2026-08+）
      customerRelationId: `REL_${i}`, customerName: `C${i}`, status: 'Issued', type: 'Receivable',
    }));
    const prisma = makePrisma({ invoices });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.arApAlerts.receivable.rows).toHaveLength(5); // Top5 截断
    const total = cockpit.arApAlerts.receivable.totals.find(t => t.currency === 'USD')!;
    expect(total.overdue).toBe(2800); // 100+200+...+700
    expect(total.total).toBe(2800);
  });

  it('excludes fully-allocated invoices from alerts', async () => {
    const prisma = makePrisma({
      invoices: [{
        id: 'INV1', invoiceNumber: 'INV-1', amount: 1000, currency: 'USD',
        issueDate: '2026-01-01', dueDate: '2026-02-01',
        customerRelationId: 'REL_A', customerName: 'ACME', status: 'Issued', type: 'Receivable',
      }],
      allocGroupBy: [{ invoiceId: 'INV1', _sum: { appliedAmount: 1000 } }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.arApAlerts.receivable.rows).toHaveLength(0);
    expect(cockpit.arApAlerts.receivable.totals).toHaveLength(0);
  });

  /**
   * ★ 2026-09-17 新增（P4-1 P2-#5）：`arApAlerts` 是**预警**结构，只应保留**确有逾期**的币种。
   *
   * 旧实现把 `overdue = 0` 的币种也留在 `totals` 里 ⇒
   *   ① 前端渲染成「● ¥0.00」——**红色危险点配零**，视觉上像"有逾期"；
   *   ② 前端「无逾期」空态判据是 `rows.length === 0`（**没有任何币种**）
   *      ⇒ 只要存在「有应收但未逾期」的币种，空态**永不触发**。
   *
   * ★ 本条有区分度：EUR 有应收（aging 行存在）但**未逾期** ⇒ 修前 `totals` 会是
   * `['EUR','USD']`，修后只剩 `['USD']`。
   */
  it('★ 只保留确有逾期的币种（overdue=0 的币种不进 arApAlerts）', async () => {
    const prisma = makePrisma({
      invoices: [
        {
          // USD：已逾期（dueDate 在过去）
          id: 'INV_USD', invoiceNumber: 'INV-U', amount: 1000, currency: 'USD',
          issueDate: '2026-01-01', dueDate: '2026-02-01',
          customerRelationId: 'REL_U', customerName: 'U', status: 'Issued', type: 'Receivable',
        },
        {
          // EUR：有应收但**未逾期**（dueDate 在很远的未来）→ overdue 桶全 0
          id: 'INV_EUR', invoiceNumber: 'INV-E', amount: 2000, currency: 'EUR',
          issueDate: '2026-08-01', dueDate: '2099-01-01',
          customerRelationId: 'REL_E', customerName: 'E', status: 'Issued', type: 'Receivable',
        },
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const currencies = cockpit.arApAlerts.receivable.totals.map(t => t.currency);
    expect(currencies).toEqual(['USD']); // 修前为 ['EUR','USD'] 或 ['USD','EUR']
    expect(currencies).not.toContain('EUR');
    // 不变量：返回的每个桶都必须真的有逾期（这正是「无逾期」空态可达的前提）
    expect(cockpit.arApAlerts.receivable.totals.every(t => t.overdue > 0)).toBe(true);
  });
});

describe('getBusinessCockpit — 汇率损益汇总', () => {
  it('passes through fx totals with row count', async () => {
    const prisma = makePrisma({
      invoices: [{
        id: 'INV1', invoiceNumber: 'INV-1', type: 'Receivable', currency: 'USD',
        exchangeRate: 7.1, baseCurrency: 'CNY', amount: 1000,
        issueDate: '2026-07-01', dueDate: null, customerRelationId: 'REL_A', customerName: 'ACME', status: 'PartiallyPaid',
      }],
      vouchers: [{ id: 'V1', voucherNumber: 'V-1', exchangeRate: 7.2 }],
      allocations: [{ id: 'A1', invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 1000, appliedDate: '2026-08-01' }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.fxSummary.totalGainLoss).toBe(100); // 1000 × (7.2 - 7.1)
    expect(cockpit.fxSummary.rowCount).toBe(1);
    expect(cockpit.fxSummary.baseCurrency).toBe('CNY');
  });
});

describe('getBusinessCockpit — 日期区间', () => {
  it('filters orders by dueDate lexicographic range', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'IN', dueDate: '2026-08-15' }),
        makeOrder({ id: 'OUT', dueDate: '2026-09-01' }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma, { from: '2026-08-01', to: '2026-08-31' });
    expect(cockpit.orderMargins.rows.map(r => r.orderId)).toEqual(['IN']);
    expect(cockpit.from).toBe('2026-08-01');
    expect(cockpit.to).toBe('2026-08-31');
  });

  it('returns empty aggregates when no orders match', async () => {
    const prisma = makePrisma({ orders: [] });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard).toEqual([]);
    expect(cockpit.customerContribution).toEqual([]);
    expect(cockpit.orderMargins.totals).toEqual([]);
    expect(cockpit.orderStatusDistribution).toEqual([]);
    expect(cockpit.deliveryAlerts).toEqual([]);
    expect(cockpit.sampleProgressAlerts).toEqual([]);
    expect(cockpit.fxTrend.points).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// B2 缺口补全测试
// ════════════════════════════════════════════════════════════════

describe('getBusinessCockpit — B2: 回款率 (collectionRate)', () => {
  it('computes collectionRate for sales leaderboard rows', async () => {
    // 回款口径：核销链 appliedAmount（actualPaymentAmount 已不参与计算）
    const prisma = makePrisma({
      orders: [
        makeOrder({ contractAmount: 1000, actualPaymentAmount: null }),
        makeOrder({ id: 'O2', salesPerson: 'Bob', contractAmount: 2000, actualPaymentAmount: null }),
      ],
      invoices: [
        { id: 'INV1', orderId: 'O1', amount: 1000, currency: 'USD', type: 'Receivable', status: 'Issued' },
        { id: 'INV2', orderId: 'O2', amount: 2000, currency: 'USD', type: 'Receivable', status: 'Issued' },
      ],
      ioa: [
        { invoiceId: 'INV1', orderId: 'O1', allocatedAmount: 1000 },
        { invoiceId: 'INV2', orderId: 'O2', allocatedAmount: 2000 },
      ],
      vouchers: [{ id: 'V1', type: 'Receipt' }, { id: 'V2', type: 'Receipt' }],
      allocations: [
        { invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 800 }, // 0.8
        { invoiceId: 'INV2', voucherId: 'V2', appliedAmount: 500 }, // 0.25
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const alice = cockpit.salesLeaderboard.find(r => r.salesPerson === 'Alice')!;
    const bob = cockpit.salesLeaderboard.find(r => r.salesPerson === 'Bob')!;
    expect(alice.collectionRate).toBe(0.8);
    expect(bob.collectionRate).toBe(0.25);
  });

  it('computes collectionRate for order margin rows', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ contractAmount: 1000, actualPaymentAmount: null, supplierInvoiceAmount: 800 }),
      ],
      invoices: [{ id: 'INV1', orderId: 'O1', amount: 1000, currency: 'USD', type: 'Receivable', status: 'Issued' }],
      ioa: [{ invoiceId: 'INV1', orderId: 'O1', allocatedAmount: 1000 }],
      vouchers: [{ id: 'V1', type: 'Receipt' }],
      allocations: [{ invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 300 }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const row = cockpit.orderMargins.rows[0];
    // revenue = contractAmount = 1000, collected = 300（核销链口径）
    expect(row.collectionRate).toBe(0.3);
  });

  it('returns null collectionRate when revenue is zero', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ contractAmount: null, quoteAmount: null, actualPaymentAmount: 100, supplierInvoiceAmount: 0 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const row = cockpit.orderMargins.rows[0];
    expect(row.collectionRate).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// 回款口径切换（2026-09-02）：核销链真源 = Σ InvoiceAllocation.appliedAmount
// ════════════════════════════════════════════════════════════════
describe('getBusinessCockpit — 回款核销链口径 (collectOrderReceipts)', () => {
  it('ignores Order.actualPaymentAmount entirely (manual field, never written back)', async () => {
    const prisma = makePrisma({
      orders: [makeOrder({ contractAmount: 1000, actualPaymentAmount: 999 })],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard[0].collectedAmount).toBe(0);
    expect(cockpit.orderMargins.rows[0].collectionRate).toBe(0);
  });

  it('falls back to Invoice.orderId direct link when no IOA rows exist', async () => {
    const prisma = makePrisma({
      orders: [makeOrder({ contractAmount: 1000 })],
      invoices: [{ id: 'INV1', orderId: 'O1', amount: 1000, currency: 'USD', type: 'Receivable', status: 'Issued' }],
      vouchers: [{ id: 'V1', type: 'Receipt' }],
      allocations: [{ invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 400 }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard[0].collectedAmount).toBe(400);
  });

  it('distributes one invoice paid amount across orders by IOA weights', async () => {
    // INV1 1000 已收 300，IOA 分摊 O1:400 / O2:600 → O1 收 120 / O2 收 180
    const prisma = makePrisma({
      orders: [
        makeOrder({ contractAmount: 400, actualPaymentAmount: null }),
        makeOrder({ id: 'O2', salesPerson: 'Bob', contractAmount: 600, actualPaymentAmount: null }),
      ],
      invoices: [{ id: 'INV1', orderId: 'O1', amount: 1000, currency: 'USD', type: 'Receivable', status: 'PartiallyPaid' }],
      ioa: [
        { invoiceId: 'INV1', orderId: 'O1', allocatedAmount: 400 },
        { invoiceId: 'INV1', orderId: 'O2', allocatedAmount: 600 },
      ],
      vouchers: [{ id: 'V1', type: 'Receipt' }],
      allocations: [{ invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 300 }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const alice = cockpit.salesLeaderboard.find(r => r.salesPerson === 'Alice')!;
    const bob = cockpit.salesLeaderboard.find(r => r.salesPerson === 'Bob')!;
    expect(alice.collectedAmount).toBe(120);
    expect(bob.collectedAmount).toBe(180);
  });

  it('excludes cross-currency receipts from order collected amount (no silent conversion)', async () => {
    // 订单销售币种 USD，发票 EUR 实收 500 → 不并入 USD 回款行
    const prisma = makePrisma({
      orders: [makeOrder({ contractAmount: 1000, salesCurrency: 'USD', currency: 'USD' })],
      invoices: [{ id: 'INV1', orderId: 'O1', amount: 500, currency: 'EUR', type: 'Receivable', status: 'Issued' }],
      ioa: [{ invoiceId: 'INV1', orderId: 'O1', allocatedAmount: 500 }],
      vouchers: [{ id: 'V1', type: 'Receipt' }],
      allocations: [{ invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 500 }],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard[0].collectedAmount).toBe(0);
  });

  it('ignores Disbursement vouchers and Cancelled invoices', async () => {
    const prisma = makePrisma({
      orders: [makeOrder({ contractAmount: 1000 })],
      invoices: [
        { id: 'INV1', orderId: 'O1', amount: 400, currency: 'USD', type: 'Receivable', status: 'Cancelled' },
        { id: 'INV2', orderId: 'O1', amount: 600, currency: 'USD', type: 'Payable', status: 'Issued' },
      ],
      vouchers: [{ id: 'V1', type: 'Disbursement' }],
      allocations: [
        { invoiceId: 'INV1', voucherId: 'V1', appliedAmount: 400 },
        { invoiceId: 'INV2', voucherId: 'V1', appliedAmount: 600 },
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.salesLeaderboard[0].collectedAmount).toBe(0);
  });
});

describe('getBusinessCockpit — B2: 新老客标记 (isNewCustomer)', () => {
  it('marks customer as new when no prior orders exist before from date', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'CUR1', customer: 'NEWCO', customerRelationId: 'REL_NEW', dueDate: '2026-08-15' }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma, { from: '2026-08-01', to: '2026-08-31' });
    const newco = cockpit.customerContribution.find(r => r.customer === 'NEWCO')!;
    expect(newco.isNewCustomer).toBe(true);
  });

  it('marks customer as existing when prior orders exist before from date', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'OLD1', customer: 'ACME', customerRelationId: 'REL_A', dueDate: '2026-07-15' }),
        makeOrder({ id: 'CUR1', customer: 'ACME', customerRelationId: 'REL_A', dueDate: '2026-08-15' }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma, { from: '2026-08-01', to: '2026-08-31' });
    const acme = cockpit.customerContribution.find(r => r.customer === 'ACME')!;
    expect(acme.isNewCustomer).toBe(false);
  });

  it('defaults isNewCustomer to false when no from date specified', async () => {
    const prisma = makePrisma({
      orders: [makeOrder({ customer: 'NEWCO', customerRelationId: 'REL_NEW' })],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const newco = cockpit.customerContribution.find(r => r.customer === 'NEWCO')!;
    expect(newco.isNewCustomer).toBe(false);
  });
});

describe('getBusinessCockpit — B2: 最近下单日期 (lastOrderDate)', () => {
  it('tracks the max dueDate per customer in range', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'O1', customer: 'ACME', customerRelationId: 'REL_A', dueDate: '2026-08-10' }),
        makeOrder({ id: 'O2', customer: 'ACME', customerRelationId: 'REL_A', dueDate: '2026-08-25' }),
        makeOrder({ id: 'O3', customer: 'ACME', customerRelationId: 'REL_A', dueDate: '2026-08-15' }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const acme = cockpit.customerContribution.find(r => r.customer === 'ACME')!;
    expect(acme.lastOrderDate).toBe('2026-08-25');
  });
});

describe('getBusinessCockpit — B2: 订单状态分布 (orderStatusDistribution)', () => {
  it('groups by status × currency with count and salesAmount', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'O1', status: 'Pending', contractAmount: 1000 }),
        makeOrder({ id: 'O2', status: 'Pending', contractAmount: 500 }),
        makeOrder({ id: 'O3', status: 'Production', contractAmount: 2000 }),
        makeOrder({ id: 'O4', status: 'Production', salesCurrency: 'EUR', contractAmount: 800 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.orderStatusDistribution).toHaveLength(3);
    const pendingUsd = cockpit.orderStatusDistribution.find(b => b.status === 'Pending' && b.currency === 'USD')!;
    expect(pendingUsd.count).toBe(2);
    expect(pendingUsd.salesAmount).toBe(1500);
    const prodEur = cockpit.orderStatusDistribution.find(b => b.status === 'Production' && b.currency === 'EUR')!;
    expect(prodEur.count).toBe(1);
    expect(prodEur.salesAmount).toBe(800);
  });

  it('sorts by count descending', async () => {
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'O1', status: 'Production' }),
        makeOrder({ id: 'O2', status: 'Pending' }),
        makeOrder({ id: 'O3', status: 'Pending' }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.orderStatusDistribution[0].status).toBe('Pending');
    expect(cockpit.orderStatusDistribution[0].count).toBe(2);
  });
});

describe('getBusinessCockpit — B2: 交付预警 (deliveryAlerts)', () => {
  it('includes non-terminal orders due within 7 days or overdue', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const future3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const future15 = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
    const past5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'DUE3', status: 'Production', dueDate: future3 }),
        makeOrder({ id: 'DUE15', status: 'Production', dueDate: future15 }),
        makeOrder({ id: 'OVERDUE', status: 'Confirmed', dueDate: past5 }),
        makeOrder({ id: 'SHIPPED', status: 'Shipped', dueDate: past5 }), // terminal → excluded
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const ids = cockpit.deliveryAlerts.map(a => a.orderId);
    expect(ids).toContain('DUE3');
    expect(ids).toContain('OVERDUE');
    expect(ids).not.toContain('DUE15'); // > 7 days
    expect(ids).not.toContain('SHIPPED'); // terminal status
  });

  it('sorts by daysUntilDue ascending (most overdue first)', async () => {
    const future2 = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const past3 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const past10 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'F2', status: 'Production', dueDate: future2 }),
        makeOrder({ id: 'P3', status: 'Production', dueDate: past3 }),
        makeOrder({ id: 'P10', status: 'Production', dueDate: past10 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.deliveryAlerts.map(a => a.orderId)).toEqual(['P10', 'P3', 'F2']);
  });

  it('excludes non-terminal orders with null dueDate (no fake 0-day urgency)', async () => {
    const future3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const prisma = makePrisma({
      orders: [
        makeOrder({ id: 'NODUE', status: 'Production', dueDate: null }),
        makeOrder({ id: 'DUE3', status: 'Production', dueDate: future3 }),
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    const ids = cockpit.deliveryAlerts.map(a => a.orderId);
    expect(ids).toContain('DUE3');
    expect(ids).not.toContain('NODUE'); // null 交期不进预警列表
  });
});

describe('getBusinessCockpit — B2: 样品进度预警 (sampleProgressAlerts)', () => {
  it('flags active cases with overdue targetDate', async () => {
    const pastDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const futureDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const prisma = makePrisma({
      devCases: [
        { id: 'DC1', code: 'DEV-001', name: 'Cotton Twill', stage: 'developing', priority: 'urgent', customerName: 'ACME', productName: 'Tw-001', currentRound: 2, targetDate: pastDate, completedDate: null },
        { id: 'DC2', code: 'DEV-002', name: 'Linen Shirt', stage: 'shipping', priority: 'normal', customerName: 'BETA', productName: 'Ln-002', currentRound: 1, targetDate: futureDate, completedDate: null },
        { id: 'DC3', code: 'DEV-003', name: 'Old Case', stage: 'approved', priority: 'low', customerName: 'GMBH', productName: 'Old', currentRound: 1, targetDate: pastDate, completedDate: '2026-07-01' },
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.sampleProgressAlerts).toHaveLength(1);
    expect(cockpit.sampleProgressAlerts[0].caseId).toBe('DC1');
    expect(cockpit.sampleProgressAlerts[0].priority).toBe('urgent');
    expect(cockpit.sampleProgressAlerts[0].daysOverdue).toBeGreaterThan(0);
  });

  it('returns empty when no overdue cases', async () => {
    const futureDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const prisma = makePrisma({
      devCases: [
        { id: 'DC1', code: 'DEV-001', name: 'Future', stage: 'developing', priority: 'normal', customerName: null, productName: null, currentRound: 1, targetDate: futureDate, completedDate: null },
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.sampleProgressAlerts).toEqual([]);
  });
});

describe('getBusinessCockpit — B2: 汇率走势 (fxTrend)', () => {
  it('returns fx rate points sorted by date ascending', async () => {
    const prisma = makePrisma({
      fxRates: [
        { currency: 'USD', rate: '7.15', effectiveDate: '2026-08-03' },
        { currency: 'USD', rate: '7.12', effectiveDate: '2026-08-01' },
        { currency: 'EUR', rate: '7.80', effectiveDate: '2026-08-02' },
      ],
    });
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.fxTrend.baseCurrency).toBe('CNY');
    expect(cockpit.fxTrend.points).toHaveLength(3);
    // Sorted by date ascending
    expect(cockpit.fxTrend.points[0].effectiveDate).toBe('2026-08-01');
    expect(cockpit.fxTrend.points[2].effectiveDate).toBe('2026-08-03');
    // Rate converted to number
    expect(cockpit.fxTrend.points[0].rate).toBe(7.12);
  });

  it('returns empty points when no fx rates', async () => {
    const prisma = makePrisma({});
    const cockpit = await getBusinessCockpit(prisma);
    expect(cockpit.fxTrend.points).toEqual([]);
    expect(cockpit.fxTrend.baseCurrency).toBe('CNY');
  });
});
