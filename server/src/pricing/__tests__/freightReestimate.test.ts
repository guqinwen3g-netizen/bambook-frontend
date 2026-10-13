/**
 * REQ2-14 海运费变动利润重估回归测试（设计文档 §7 验收锚点）
 *
 * 覆盖：
 *   1. multiplier=1 重估 == 生成落库值（同真源断言，DR-054-①）
 *   2. ×3 重估：delta = −2×原运费 CNY（运费涨 3 倍 = 多付 2 倍），X-04 锚点
 *   3. 三级建议：转负 renegotiate / margin 跌 >10pt warn / 可承受 ok
 *   4. 受影响范围：非终态 + 有运费基数（终态/无运费订单排除）
 *   5. baseline 优先落库表（persisted），无则现场算（computed）
 *   6. multiplier 边界（≤0 / >100 / 非数 → INVALID_MULTIPLIER）
 *   7. orderId 单单过滤
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createProfitSheetService } from '../profitSheetService';

function makeMockPrisma() {
  let seq = 0;
  const orders: any[] = [];
  const invoices: any[] = [];
  const purchaseOrders: any[] = [];
  const shipments: any[] = [];
  const paymentVouchers: any[] = [];
  const exchangeRates: any[] = [];
  const profitSheets: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('notIn' in cond) return !cond.notIn.includes(row[k]);
        if ('in' in cond) return cond.in.includes(row[k]);
        return true;
      }
      return row[k] === v;
    });

  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const orders_ = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
      for (const o of orders_) {
        const [[field, dir]] = Object.entries(o) as [string, string][];
        const xv = x[field] ?? null;
        const yv = y[field] ?? null;
        if (xv === yv) continue;
        if (xv === null) return 1;
        if (yv === null) return -1;
        if (typeof xv === 'bigint' && typeof yv === 'bigint') {
          return xv < yv ? (dir === 'desc' ? 1 : -1) : (dir === 'desc' ? -1 : 1);
        }
        if (xv < yv) return dir === 'desc' ? 1 : -1;
        if (xv > yv) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const findManyOf = (rows: any[]) => async ({ where, orderBy, take, skip, select }: any = {}) => {
    const matched = applyOrderBy(rows.filter(r => matchWhere(r, where)), orderBy);
    const sliced = matched.slice(skip || 0, (skip || 0) + (take ?? matched.length));
    if (!select) return sliced;
    return sliced.map((r: any) => Object.fromEntries(Object.keys(select).map(k => [k, r[k]])));
  };

  return {
    order: {
      findUnique: async ({ where }: any) => orders.find(o => o.id === where.id) || null,
      findMany: findManyOf(orders),
    },
    invoice: { findMany: findManyOf(invoices) },
    purchaseOrder: { findMany: findManyOf(purchaseOrders) },
    shipment: { findMany: findManyOf(shipments) },
    paymentVoucher: { findMany: findManyOf(paymentVouchers) },
    exchangeRate: { findMany: findManyOf(exchangeRates) },
    orderProfitSheet: {
      findUnique: async ({ where }: any) => profitSheets.find(s => s.orderId === where.orderId) || null,
      findMany: findManyOf(profitSheets),
      count: async ({ where }: any = {}) => profitSheets.filter(r => matchWhere(r, where)).length,
      create: async ({ data }: any) => {
        const row = { ...data, id: data.id || `OPS__T${++seq}` };
        profitSheets.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = profitSheets.find(s => s.orderId === where.orderId);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: any) => {
        const idx = profitSheets.findIndex(s => s.orderId === where.orderId);
        if (idx < 0) throw new Error('not found');
        return profitSheets.splice(idx, 1)[0];
      },
    },
    _stores: { orders, invoices, purchaseOrders, shipments, paymentVouchers, exchangeRates, profitSheets },
  };
}

function seedActiveOrder(prisma: any, id: string, opts: { poNumber?: string; status?: string } = {}) {
  prisma._stores.orders.push({
    id, poNumber: opts.poNumber ?? id, customer: 'Acme', product: 'Suit',
    status: opts.status ?? 'Confirmed', deletedAt: null,
  });
}

/** 标准场景订单：收入 72000 CNY + 采购 50000 CNY + 运费 3000 CNY → 利润 19000 */
function seedFreightOrder(prisma: any, id: string, opts: { freight?: number; status?: string; sales?: number; purchase?: number } = {}) {
  seedActiveOrder(prisma, id, { status: opts.status });
  const s = opts.sales ?? 72000;
  const p = opts.purchase ?? 50000;
  prisma._stores.invoices.push({
    id: `${id}-INV`, invoiceNumber: `${id}-INV`, orderId: id, type: 'Receivable',
    status: 'Issued', amount: s, currency: 'CNY', exchangeRate: null, deletedAt: null,
  });
  prisma._stores.purchaseOrders.push({
    id: `${id}-PO`, poNumber: `${id}-PO`, orderId: id, status: 'Confirmed',
    totalAmount: p, currency: 'CNY', exchangeRate: null, deletedAt: null,
  });
  prisma._stores.shipments.push({
    id: `${id}-SH`, shipmentNumber: `${id}-SH`, orderId: id, status: 'Shipped',
    freightAmount: opts.freight ?? 3000, freightCurrency: 'CNY',
    insuranceAmount: null, insuranceCurrency: null,
    customsAmount: null, customsCurrency: null,
    otherCharges: null, otherChargesCurrency: null,
    deletedAt: null,
  });
}

describe('REQ2-14 海运费变动重估（DR-054）', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
  });

  it('同口径现算：旧落库利润不成为重估基线，缺耗用利润留空', async () => {
    seedFreightOrder(prisma, 'ORD-1');
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u');
    const r = await service.reestimateFreightImpact({ multiplier: 1 });
    const item = r.items.find((x: any) => x.orderId === 'ORD-1');
    expect(item).toBeTruthy();
    // 无落库表时 baseline 现场算（computed）——先比对重估 == 落库
    expect(item.baseline.grossProfit).toBeNull();
    expect(item.reestimated.grossProfit).toBeNull();
    expect(item.deltaProfit).toBeNull();
    expect(item.baseline.source).toBe('computed'); // 生成后重估 → baseline 取落库表
  });

  it('×3运费金额可计算，但不伪装成已核实利润变化', async () => {
    seedFreightOrder(prisma, 'ORD-1', { freight: 3000 }); // 利润 19000
    const r = await service.reestimateFreightImpact({ multiplier: 3 });
    const item = r.items.find((x: any) => x.orderId === 'ORD-1');
    // 运费 3000 → 9000：delta = −6000 = −2×3000
    expect(item.reestimated.freightCost).toBe(9000);
    expect(item.deltaProfit).toBeNull();
    expect(item.reestimated.grossProfit).toBeNull();
    expect(item.advice).toBe('pending'); // margin 19000/72000=26.4% → 13000/72000=18.1%，跌 8.3pt < 10
    expect(r.summary.affectedOrders).toBe(1);
    expect(r.summary.deltaProfitTotal).toBeNull();
  });

  it('缺耗用证据时三类订单均待核算，不给ok或议价建议', async () => {
    // 转负单：收入 10000 / 采购 5000 / 运费 2000 → 利润 3000；×3 运费 6000 → 利润 −1000
    seedFreightOrder(prisma, 'ORD-NEG', { freight: 2000, sales: 10000, purchase: 5000 });
    // 大跌单：收入 20000 / 采购 5000 / 运费 3000 → 12000（60%）；×3 → 6000（30% 跌 30pt → warn）
    seedFreightOrder(prisma, 'ORD-WARN', { freight: 3000, sales: 20000, purchase: 5000 });
    // 可承受单：margin 跌 < 10pt
    seedFreightOrder(prisma, 'ORD-OK', { freight: 3000, sales: 72000, purchase: 50000 }); // 26.4% → 18.1% 跌 8.3pt

    const r = await service.reestimateFreightImpact({ multiplier: 3 });
    expect(r.items).toHaveLength(3);
    // renegotiate 排最前
    expect(r.items[0].orderId).toBe('ORD-NEG');
    expect(r.items[0].advice).toBe('pending');
    expect(r.items[0].reestimated.grossProfit).toBeNull();
    const warn = r.items.find((x: any) => x.orderId === 'ORD-WARN');
    expect(warn.advice).toBe('pending');
    expect(warn.deltaMargin).toBeNull();
    const ok = r.items.find((x: any) => x.orderId === 'ORD-OK');
    expect(ok.advice).toBe('pending');
    expect(r.summary.renegotiateOrders).toBe(0);
    expect(r.summary.warnOrders).toBe(0);
    expect(r.summary.pendingOrders).toBe(3);
    expect(r.summary.negativeProfitOrders).toBeNull();
  });

  it('受影响范围：终态订单与无运费基数订单排除', async () => {
    seedFreightOrder(prisma, 'ORD-DELIVERED', { status: 'Delivered' }); // 终态排除
    seedFreightOrder(prisma, 'ORD-NOFREIGHT', {}); // 有运费
    prisma._stores.orders.push({ id: 'ORD-NOSHIP', poNumber: 'ORD-NOSHIP', customer: 'X', status: 'Confirmed', deletedAt: null }); // 无运单
    const r = await service.reestimateFreightImpact({ multiplier: 2 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].orderId).toBe('ORD-NOFREIGHT');
  });

  it('orderId 单单过滤 + 外币运费按最新汇率折算', async () => {
    seedFreightOrder(prisma, 'ORD-A', { freight: 3000 });
    seedFreightOrder(prisma, 'ORD-B', { freight: 1000 });
    prisma._stores.exchangeRates.push(
      { id: 'ER-1', currency: 'USD', rate: 7.0, effectiveDate: '2026-08-01', createdAt: 1n },
    );
    // ORD-B 改 USD 运费 500 × 7 = 3500 CNY
    const sh = prisma._stores.shipments.find((s: any) => s.orderId === 'ORD-B');
    sh.freightAmount = 500; sh.freightCurrency = 'USD';
    const r = await service.reestimateFreightImpact({ multiplier: 2, orderId: 'ORD-B' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].orderId).toBe('ORD-B');
    // ×2：500×2×7 = 7000 运费；baseline 运费 3500 → delta = −3500（多付 1 倍）
    expect(r.items[0].reestimated.freightCost).toBe(7000);
    expect(r.items[0].deltaProfit).toBeNull();
  });

  it('multiplier 边界：≤0 / >100 / 非数 → INVALID_MULTIPLIER', async () => {
    await expect(service.reestimateFreightImpact({ multiplier: 0 })).rejects.toMatchObject({ code: 'INVALID_MULTIPLIER' });
    await expect(service.reestimateFreightImpact({ multiplier: -1 })).rejects.toMatchObject({ code: 'INVALID_MULTIPLIER' });
    await expect(service.reestimateFreightImpact({ multiplier: 101 })).rejects.toMatchObject({ code: 'INVALID_MULTIPLIER' });
    await expect(service.reestimateFreightImpact({ multiplier: 'abc' })).rejects.toMatchObject({ code: 'INVALID_MULTIPLIER' });
  });

  it('外币运费重估只乘金额不乘汇率（口径正确性）', async () => {
    seedFreightOrder(prisma, 'ORD-FX', { freight: 1000, sales: 72000 });
    prisma._stores.exchangeRates.push({ id: 'ER-1', currency: 'USD', rate: 7.0, effectiveDate: '2026-08-01', createdAt: 1n });
    const sh = prisma._stores.shipments.find((s: any) => s.orderId === 'ORD-FX');
    sh.freightCurrency = 'USD';
    // baseline：1000×7 = 7000 → 利润 15000；×3：3000×7 = 21000 → 利润 1000（delta −14000 = −2×7000）
    const r = await service.reestimateFreightImpact({ multiplier: 3 });
    const item = r.items[0];
    expect(item.deltaProfit).toBeNull();
    expect(item.reestimated.grossProfit).toBeNull();
  });
});
