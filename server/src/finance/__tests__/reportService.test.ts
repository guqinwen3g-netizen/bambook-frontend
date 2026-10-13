/**
 * Phase B2 — 财务报表服务单元测试
 *
 * 覆盖：
 *   - 账龄分析：五桶分布（current/1-30/31-60/61-90/90+）+ 未核销余额口径 + 客户×币种分组 + 全额核销排除
 *   - 客户对账单：期初余额 + 借贷流水 + running balance + 多币种分节
 *   - 汇率损益：Receivable/Payable 方向 + 缺汇率/本币跳过 + 日期区间过滤
 */

import { describe, expect, it, vi } from 'vitest';
import { getAgingReport, getCustomerStatement, getSupplierStatement, getFxGainLoss } from '../reportService';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makePrisma(opts: {
  invoices?: any[];
  vouchers?: any[];
  allocations?: any[];
  allocGroupBy?: any[];
  settlements?: any[];  // FxSettlement（P2-7 汇率链 C 段）
  locks?: any[];        // FxRateLock（P2-7 锁汇覆盖标记）
  relations?: any[];   // B266：对账单名字兜底要回读档案
}) {
  return {
    // B266 连带：这两份桩里没有 relation 这张表 ⇒ 服务层加了"名字兜底回读档案"之后会 TypeError。
    //   默认查不到关系（与这些用例的旧世界一致：票面名都在，兜底不触发）；要给兜底喂数据就传 opts.relations。
    relation: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any = {}) =>
        (opts.relations ?? []).find((r: any) => r.id === where?.id) ?? null),
    },
    invoice: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.invoices ?? [];
        // reportService 的查询模式：按 id in 过滤（FX）或按业务 where 过滤（aging/statement）
        if (where?.id?.in) return rows.filter(r => where.id.in.includes(r.id));
        if (where?.customerRelationId) rows = rows.filter(r => r.customerRelationId === where.customerRelationId);
        // type 过滤仅在行数据携带 type 字段时生效（既有用例行无 type，不破坏存量断言）
        if (where?.type) rows = rows.filter(r => r.type == null || r.type === where.type);
        if (where?.status?.not) rows = rows.filter(r => r.status == null || r.status !== where.status.not);
        return rows;
      }),
    },
    paymentVoucher: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.vouchers ?? [];
        if (where?.id?.in) return rows.filter(r => where.id.in.includes(r.id));
        if (where?.customerRelationId) rows = rows.filter(r => r.customerRelationId === where.customerRelationId);
        if (where?.type) rows = rows.filter(r => r.type == null || r.type === where.type);
        if (where?.status?.notIn) rows = rows.filter(r => r.status == null || !where.status.notIn.includes(r.status));
        // A2 收款归属查询：`OR: [{ customerRelationId }, { id: { in: 代付凭证 } }]`
        if (Array.isArray(where?.OR)) {
          const hit = new Set<any>();
          for (const cond of where.OR) {
            for (const r of opts.vouchers ?? []) {
              if (cond.customerRelationId && r.customerRelationId === cond.customerRelationId) hit.add(r);
              if (cond.id?.in && cond.id.in.includes(r.id)) hit.add(r);
            }
          }
          rows = (opts.vouchers ?? []).filter(r => hit.has(r));
        }
        return rows;
      }),
    },
    invoiceAllocation: {
      groupBy: vi.fn().mockResolvedValue(opts.allocGroupBy ?? []),
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        // 兼容旧「按 invoiceId 汇总」夹具（allocGroupBy 形态 → 明细形态）：
        // 2026-09-19 起发票侧已核销改走 findMany 真源（含贷项票抵扣），见 shared/invoiceAppliedSum
        let rows = opts.allocations?.length
          ? opts.allocations
          : (opts.allocGroupBy ?? []).map((g: any) => ({ invoiceId: g.invoiceId, appliedAmount: g._sum?.appliedAmount ?? 0 }));
        if (where?.appliedDate?.gte) rows = rows.filter(r => r.appliedDate >= where.appliedDate.gte);
        if (where?.appliedDate?.lte) rows = rows.filter(r => r.appliedDate <= where.appliedDate.lte);
        if (where?.invoiceId?.in) rows = rows.filter(r => where.invoiceId.in.includes(r.invoiceId));
        if (where?.voucherId?.in) rows = rows.filter(r => where.voucherId.in.includes(r.voucherId));
        return rows;
      }),
    },
    // ── P2-7 汇率链 C 段（结汇）+ 锁汇覆盖 ──
    fxSettlement: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = (opts.settlements ?? []).filter(r => r.deletedAt == null);
        if (where?.settleDate?.gte) rows = rows.filter(r => r.settleDate >= where.settleDate.gte);
        if (where?.settleDate?.lte) rows = rows.filter(r => r.settleDate <= where.settleDate.lte);
        return rows;
      }),
    },
    fxRateLock: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = (opts.locks ?? []).filter(r => r.deletedAt == null);
        if (where?.orderId?.in) rows = rows.filter(r => where.orderId.in.includes(r.orderId));
        return rows;
      }),
    },
  } as any;
}

describe('getAgingReport', () => {
  it('assigns open amounts to correct buckets and groups by customer+currency', async () => {
    const prisma = makePrisma({
      invoices: [
        // current：未到期（dueDate 未来）
        { id: 'INV1', invoiceNumber: 'INV-1', amount: 1000, currency: 'USD', issueDate: '2026-07-01', dueDate: '2026-09-01', customerRelationId: 'REL_A', customerName: 'ACME', status: 'Issued' },
        // 逾期 10 天 → d1_30
        { id: 'INV2', invoiceNumber: 'INV-2', amount: 2000, currency: 'USD', issueDate: '2026-06-01', dueDate: '2026-07-28', customerRelationId: 'REL_A', customerName: 'ACME', status: 'PartiallyPaid' },
        // 逾期 45 天 → d31_60
        { id: 'INV3', invoiceNumber: 'INV-3', amount: 3000, currency: 'USD', issueDate: '2026-05-01', dueDate: '2026-06-23', customerRelationId: 'REL_B', customerName: 'BETA', status: 'Issued' },
        // 逾期 75 天 → d61_90
        { id: 'INV4', invoiceNumber: 'INV-4', amount: 4000, currency: 'EUR', issueDate: '2026-03-01', dueDate: '2026-05-24', customerRelationId: 'REL_B', customerName: 'BETA', status: 'Issued' },
        // 逾期 120 天 → d90plus
        { id: 'INV5', invoiceNumber: 'INV-5', amount: 5000, currency: 'USD', issueDate: '2026-01-01', dueDate: '2026-04-09', customerRelationId: 'REL_A', customerName: 'ACME', status: 'Issued' },
      ],
      allocGroupBy: [
        { invoiceId: 'INV2', _sum: { appliedAmount: 500 } }, // INV2 未核销 1500
      ],
    });

    const report = await getAgingReport(prisma, { type: 'Receivable', asOf: '2026-08-07' });

    const acme = report.rows.find(r => r.customerName === 'ACME' && r.currency === 'USD')!;
    expect(acme.buckets.current).toBe(1000);
    expect(acme.buckets.d1_30).toBe(1500); // 2000 - 500 核销
    expect(acme.buckets.d90plus).toBe(5000);
    expect(acme.buckets.total).toBe(7500);
    expect(acme.invoiceCount).toBe(3);

    const betaUsd = report.rows.find(r => r.customerName === 'BETA' && r.currency === 'USD')!;
    expect(betaUsd.buckets.d31_60).toBe(3000);

    const betaEur = report.rows.find(r => r.customerName === 'BETA' && r.currency === 'EUR')!;
    expect(betaEur.buckets.d61_90).toBe(4000);

    const usdTotal = report.totals.find(t => t.currency === 'USD')!;
    expect(usdTotal.total).toBe(10500);
    const eurTotal = report.totals.find(t => t.currency === 'EUR')!;
    expect(eurTotal.total).toBe(4000);
  });

  it('T2 顺带修（口径翻转）：excludes fully-allocated invoices；dueDate 缺失不再按 issueDate 判逾期 → 落 current 桶', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'INV1', invoiceNumber: 'INV-1', amount: 1000, currency: 'USD', issueDate: '2026-07-01', dueDate: null, customerRelationId: 'REL_A', customerName: 'ACME', status: 'Issued' },
        { id: 'INV2', invoiceNumber: 'INV-2', amount: 2000, currency: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-02', customerRelationId: 'REL_A', customerName: 'ACME', status: 'PartiallyPaid' },
      ],
      allocGroupBy: [
        { invoiceId: 'INV2', _sum: { appliedAmount: 2000 } }, // 全额核销 → 排除
      ],
    });

    const report = await getAgingReport(prisma, { type: 'Receivable', asOf: '2026-08-07' });
    expect(report.rows).toHaveLength(1);
    // 旧口径：dueDate ?? issueDate → issueDate 距 asOf 37 天落 d31_60（虚增逾期，
    // 与催款侧「无 dueDate 永不进催款」矛盾）。新口径：无 dueDate = 不判逾期 → current。
    expect(report.rows[0].buckets.current).toBe(1000);
    expect(report.rows[0].buckets.d31_60).toBe(0);
  });
});

describe('getCustomerStatement', () => {
  const invoices = [
    { invoiceNumber: 'INV-001', amount: 10000, currency: 'USD', issueDate: '2026-05-01', customerRelationId: 'REL_A', customerName: 'ACME' },
    { invoiceNumber: 'INV-002', amount: 5000, currency: 'USD', issueDate: '2026-07-01', customerRelationId: 'REL_A', customerName: 'ACME' },
    { invoiceNumber: 'INV-003', amount: 3000, currency: 'EUR', issueDate: '2026-07-15', customerRelationId: 'REL_A', customerName: 'ACME' },
  ];
  const vouchers = [
    { voucherNumber: 'PAY-001', amount: 4000, currency: 'USD', paymentDate: '2026-06-01', customerRelationId: 'REL_A', customerName: 'ACME' },
    { voucherNumber: 'PAY-002', amount: 2000, currency: 'USD', paymentDate: '2026-07-20', customerRelationId: 'REL_A', customerName: 'ACME' },
  ];

  it('builds per-currency sections with opening balance and running balance', async () => {
    const prisma = makePrisma({ invoices, vouchers });
    const stmt = await getCustomerStatement(prisma, { customerRelationId: 'REL_A', from: '2026-07-01', to: '2026-07-31' });

    expect(stmt.customerName).toBe('ACME');
    const usd = stmt.sections.find(s => s.currency === 'USD')!;
    // 期初 = 5月开票 10000 - 6月收款 4000 = 6000
    expect(usd.openingBalance).toBe(6000);
    expect(usd.transactions).toHaveLength(2);
    // 7/1 开票 5000 → 11000；7/20 收款 2000 → 9000
    expect(usd.transactions[0]).toMatchObject({ kind: 'invoice', number: 'INV-002', debit: 5000, balance: 11000 });
    expect(usd.transactions[1]).toMatchObject({ kind: 'receipt', number: 'PAY-002', credit: 2000, balance: 9000 });
    expect(usd.closingBalance).toBe(9000);

    const eur = stmt.sections.find(s => s.currency === 'EUR')!;
    expect(eur.openingBalance).toBe(0);
    expect(eur.closingBalance).toBe(3000);
  });

  it('returns full history when no date range given', async () => {
    const prisma = makePrisma({ invoices, vouchers });
    const stmt = await getCustomerStatement(prisma, { customerRelationId: 'REL_A' });
    const usd = stmt.sections.find(s => s.currency === 'USD')!;
    expect(usd.openingBalance).toBe(0);
    expect(usd.transactions).toHaveLength(4);
    // 10000 - 4000 + 5000 - 2000 = 9000
    expect(usd.closingBalance).toBe(9000);
  });
});

describe('getSupplierStatement', () => {
  // 供应商对账 = 应付侧镜像：Payable 发票（借，应付增加）+ Disbursement 凭证（贷，应付减少）
  const invoices = [
    { id: 'INV-S01', invoiceNumber: 'INV-S01', type: 'Payable', amount: 8000, currency: 'CNY', issueDate: '2026-05-10', customerRelationId: 'REL_S', customerName: '宏远纺织' },
    { id: 'INV-S02', invoiceNumber: 'INV-S02', type: 'Payable', amount: 6000, currency: 'CNY', issueDate: '2026-07-05', customerRelationId: 'REL_S', customerName: '宏远纺织' },
    // 同一供应商的应收侧发票不得混入（如供应商同时为客户的双向场景）
    { id: 'INV-R01', invoiceNumber: 'INV-R01', type: 'Receivable', amount: 9999, currency: 'CNY', issueDate: '2026-07-06', customerRelationId: 'REL_S', customerName: '宏远纺织' },
  ];
  const vouchers = [
    { id: 'V-S01', voucherNumber: 'PAY-S01', type: 'Disbursement', amount: 3000, currency: 'CNY', paymentDate: '2026-06-15', status: 'reconciled', customerRelationId: 'REL_S', customerName: '宏远纺织' },
    { id: 'V-S02', voucherNumber: 'PAY-S02', type: 'Disbursement', amount: 4000, currency: 'CNY', paymentDate: '2026-07-20', status: 'reconciled', customerRelationId: 'REL_S', customerName: '宏远纺织' },
    { voucherNumber: 'PAY-R01', type: 'Receipt', amount: 8888, currency: 'CNY', paymentDate: '2026-07-21', customerRelationId: 'REL_S', customerName: '宏远纺织' },
  ];

  const allocations = [
    { invoiceId: 'INV-S01', voucherId: 'V-S01', appliedAmount: 3000 },
    { invoiceId: 'INV-S02', voucherId: 'V-S02', appliedAmount: 4000 },
  ];

  it('builds payable-side sections: invoices debit, disbursements credit, excludes receivable side', async () => {
    const prisma = makePrisma({ invoices, vouchers, allocations });
    const stmt = await getSupplierStatement(prisma, { supplierRelationId: 'REL_S', from: '2026-07-01', to: '2026-07-31' });

    expect(stmt.supplierName).toBe('宏远纺织');
    const cny = stmt.sections.find(s => s.currency === 'CNY')!;
    // 期初 = 5月收票 8000 - 6月付款 3000 = 5000
    expect(cny.openingBalance).toBe(5000);
    // 期间仅 7/5 收票 + 7/20 付款；应收发票与收款凭证被排除
    expect(cny.transactions).toHaveLength(2);
    expect(cny.transactions[0]).toMatchObject({ kind: 'invoice', number: 'INV-S02', debit: 6000, balance: 11000 });
    expect(cny.transactions[1]).toMatchObject({ kind: 'payment', number: 'PAY-S02', credit: 4000, balance: 7000 });
    expect(cny.closingBalance).toBe(7000);
  });

  it('returns full payable history when no date range given', async () => {
    const prisma = makePrisma({ invoices, vouchers, allocations });
    const stmt = await getSupplierStatement(prisma, { supplierRelationId: 'REL_S' });
    const cny = stmt.sections.find(s => s.currency === 'CNY')!;
    expect(cny.openingBalance).toBe(0);
    // 8000 - 3000 + 6000 - 4000 = 7000
    expect(cny.transactions).toHaveLength(4);
    expect(cny.closingBalance).toBe(7000);
  });

  it('returns empty sections for supplier without payable records', async () => {
    const prisma = makePrisma({ invoices, vouchers });
    const stmt = await getSupplierStatement(prisma, { supplierRelationId: 'REL_NONE' });
    expect(stmt.supplierName).toBeNull();
    expect(stmt.sections).toHaveLength(0);
  });

  it('subtracts only allocations to this supplier payable invoices and omits a cancelled payment', async () => {
    const prisma = makePrisma({
      invoices: [
        { id: 'INV-A', invoiceNumber: 'AP-A', type: 'Payable', status: 'Issued', amount: 8000, currency: 'CNY', issueDate: '2026-05-10', customerRelationId: 'REL_S', customerName: '宏远纺织' },
        { id: 'INV-B', invoiceNumber: 'AP-B', type: 'Payable', status: 'Issued', amount: 6000, currency: 'CNY', issueDate: '2026-06-10', customerRelationId: 'REL_S', customerName: '宏远纺织' },
      ],
      vouchers: [
        { id: 'V-PART', voucherNumber: 'PAY-PART', type: 'Disbursement', status: 'partially_reconciled', amount: 5000, currency: 'CNY', paymentDate: '2026-07-20', customerRelationId: 'REL_S', customerName: '宏远纺织' },
        { id: 'V-CANCEL', voucherNumber: 'PAY-CANCEL', type: 'Disbursement', status: 'cancelled', amount: 2000, currency: 'CNY', paymentDate: '2026-07-21', customerRelationId: 'REL_S', customerName: '宏远纺织' },
      ],
      allocations: [
        { invoiceId: 'INV-A', voucherId: 'V-PART', appliedAmount: 3000 },
        { invoiceId: 'INV-B', voucherId: 'V-PART', appliedAmount: 1000 },
      ],
    });

    const stmt = await getSupplierStatement(prisma, { supplierRelationId: 'REL_S' });
    const cny = stmt.sections.find(s => s.currency === 'CNY')!;

    expect(cny.transactions).toHaveLength(3);
    expect(cny.transactions[2]).toMatchObject({ kind: 'payment', number: 'PAY-PART', credit: 4000, balance: 10000 });
    expect(cny.transactions.some(row => row.number === 'PAY-CANCEL')).toBe(false);
    expect(cny.closingBalance).toBe(10000);
  });
});

describe('getFxGainLoss', () => {
  const invoices = [
    { id: 'INV_R', invoiceNumber: 'INV-R', type: 'Receivable', currency: 'USD', baseCurrency: 'CNY', exchangeRate: 7.0 },
    { id: 'INV_P', invoiceNumber: 'INV-P', type: 'Payable', currency: 'USD', baseCurrency: 'CNY', exchangeRate: 7.0 },
    { id: 'INV_CNY', invoiceNumber: 'INV-C', type: 'Receivable', currency: 'CNY', baseCurrency: 'CNY', exchangeRate: 1 },
    { id: 'INV_NORATE', invoiceNumber: 'INV-N', type: 'Receivable', currency: 'USD', baseCurrency: 'CNY', exchangeRate: null },
  ];
  const vouchers = [
    { id: 'VOC_UP', voucherNumber: 'PAY-UP', exchangeRate: 7.2 },   // 收款汇率升高
    { id: 'VOC_DOWN', voucherNumber: 'PAY-DOWN', exchangeRate: 6.8 }, // 付款汇率降低
    { id: 'VOC_CNY', voucherNumber: 'PAY-C', exchangeRate: 1 },
    { id: 'VOC_NORATE', voucherNumber: 'PAY-N', exchangeRate: null },
  ];

  it('computes gain for receivable rate-up and payable rate-down; skips cny/missing rates', async () => {
    const prisma = makePrisma({
      invoices,
      vouchers,
      allocations: [
        { id: 'AL1', invoiceId: 'INV_R', voucherId: 'VOC_UP', appliedAmount: 1000, appliedDate: '2026-07-01' },
        { id: 'AL2', invoiceId: 'INV_P', voucherId: 'VOC_DOWN', appliedAmount: 2000, appliedDate: '2026-07-02' },
        { id: 'AL3', invoiceId: 'INV_CNY', voucherId: 'VOC_CNY', appliedAmount: 5000, appliedDate: '2026-07-03' },
        { id: 'AL4', invoiceId: 'INV_NORATE', voucherId: 'VOC_NORATE', appliedAmount: 1000, appliedDate: '2026-07-04' },
      ],
    });

    const report = await getFxGainLoss(prisma, {});
    expect(report.rows).toHaveLength(2);
    // Receivable：1000 × (7.2 - 7.0) = +200 收益
    expect(report.rows[0]).toMatchObject({ invoiceNumber: 'INV-R', gainLoss: 200 });
    // Payable：2000 × (7.0 - 6.8) = +400 收益
    expect(report.rows[1]).toMatchObject({ invoiceNumber: 'INV-P', gainLoss: 400 });
    expect(report.totalGainLoss).toBe(600);
    expect(report.baseCurrency).toBe('CNY');
  });

  it('computes loss for receivable rate-down and filters by date range', async () => {
    const prisma = makePrisma({
      invoices,
      vouchers,
      allocations: [
        { id: 'AL1', invoiceId: 'INV_R', voucherId: 'VOC_DOWN', appliedAmount: 1000, appliedDate: '2026-07-01' },
        { id: 'AL2', invoiceId: 'INV_R', voucherId: 'VOC_UP', appliedAmount: 1000, appliedDate: '2026-08-01' },
      ],
    });

    const july = await getFxGainLoss(prisma, { from: '2026-07-01', to: '2026-07-31' });
    expect(july.rows).toHaveLength(1);
    // Receivable：1000 × (6.8 - 7.0) = -200 损失
    expect(july.rows[0].gainLoss).toBe(-200);
    expect(july.totalGainLoss).toBe(-200);
  });
});
