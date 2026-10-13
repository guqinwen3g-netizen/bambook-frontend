import type { TokenPayload } from '../auth/service';
/**
 * Phase C1 — 经营驾驶舱聚合服务（Business Cockpit）
 *
 * 口径定义：
 *   - 销售额 = 订单金额唯一真源 orderAmountOf（Kevin 2026-09-18 拍板：以明细行为准）
 *   - 回款额 = 财务核销链实收：Σ InvoiceAllocation.appliedAmount（Receipt 凭证 ×
 *     Receivable 发票），按订单归属分摊（IOA 分摊优先，Invoice.orderId 直挂兜底），
 *     与发票域/对账引擎同源（拍板③：Order.actualPaymentAmount 是手工字段不回写，
 *     69/69 全 NULL 会导致回款率恒 0）
 *   - 毛利口径：收入 = shipmentAmount ?? 订单金额真源 orderAmountOf（出运优先是业务语义）；
 *     成本 = supplierInvoiceAmount ?? (purchasePrice × quantity)
 *   - 销售币种 = salesCurrency ?? currency；采购币种 = purchaseCurrency ?? 销售币种
 *   - 跨币种订单不计算毛利（margin=null），避免汇率假设污染报表（与 B2 口径一致）；
 *     跨币种实收同样不并入订单回款行（回款率只在同币种内计算）
 *   - 日期区间按 dueDate 字典序过滤（与 B3 准交率口径一致）
 *
 * 设计决策：
 *   - 只读聚合，不写库；应收应付预警/汇率损益直接复用 B2 reportService
 *   - 多币种不折算汇总 —— 按币种分行/分合计
 */

import { PrismaClient } from '@prisma/client';
import { getAgingReport, getFxGainLoss, type AgingRow } from '../finance/reportService';
// ★ 「业务日」唯一真源（本地时区 = 中国日）。旧写法 `toISOString().slice(0,10)` 取 UTC 日，
//   本地 00:00–08:00 会差一天 → 交付预警的 daysDiff 差一天（预警窗口边界错位）。
import { todayLocalKey } from '../shared/localDate';
import { orderAmountOf } from '../shared/orderAmount';
// ★ B2 跨币种折算真源（纯函数；经 CNY 过桥，锁汇优先，缺汇率不猜）
import { convertViaCny, pickRateOn } from '../finance/crossCurrency';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface SalesLeaderboardRow {
  salesPerson: string; // 未填归 '未分配'
  currency: string;
  orderCount: number;
  salesAmount: number;
  collectedAmount: number;
  collectionRate: number | null; // collectedAmount / salesAmount（round4）
}

export interface CustomerContributionRow {
  customer: string;
  customerRelationId: string | null;
  currency: string;
  orderCount: number;
  salesAmount: number;
  share: number; // 同币种内占比 0-1（round4）
  isNewCustomer: boolean; // 区间之前无订单 → true
  lastOrderDate: string | null; // 最近下单 dueDate
}

export interface OrderMarginRow {
  orderId: string;
  poNumber: string | null;
  customer: string;
  product: string;
  salesPerson: string | null;
  dueDate: string;
  status: string;
  currency: string; // 收入币种
  revenue: number;
  cost: number | null; // 无成本数据时为 null（**原币**，采购币种金额）
  /** ★ B2：成本折成收入币种后的金额（同币种时 ≡ cost；跨币种无法折算时为 null） */
  costInSalesCurrency: number | null;
  /** 成本原币（跨币种时才与 currency 不同） */
  purchaseCurrency: string | null;
  /** ★ B2：采销币种不一致。注意 —— 不再等于「毛利为 null」，能折算就照算 */
  crossCurrency: boolean;
  /** ★ B2：折算所用汇率（1 单位采购币种 = ? 单位收入币种）；同币种/未折算为 null */
  fxRate: number | null;
  /** ★ B2：汇率来源 lock（锁汇优先）| market（市场汇率）| mixed（两侧来源不同）| null */
  fxRateSource: 'lock' | 'market' | 'mixed' | null;
  margin: number | null;
  marginRate: number | null; // margin / revenue（round4）
  collectionRate: number | null; // 核销链实收 / revenue（round4；无 revenue 时 null）
}

export interface OrderMarginTotal {
  currency: string;
  revenue: number;
  /** null = 无成本数据 or 服务端 sensitive:cost 遮罩（路由出口 sensitiveMask） */
  cost: number | null;
  /** null = 服务端 sensitive:profit 遮罩（路由出口 sensitiveMask） */
  margin: number | null;
  marginRate: number | null;
  orderCount: number; // 计入合计的订单数（排除跨币种/缺成本）
}

export interface ArApAlertBucket {
  currency: string;
  overdue: number; // d1_30 + d31_60 + d61_90 + d90plus
  total: number;
}

// ── B2 缺口补全：订单状态分布卡 ──
export interface OrderStatusBucket {
  status: string;
  count: number;
  salesAmount: number;
  currency: string;
}

// ── B2 缺口补全：交付预警 ──
export interface DeliveryAlert {
  orderId: string;
  poNumber: string | null;
  customer: string;
  product: string;
  dueDate: string;
  status: string;
  daysUntilDue: number; // 负数 = 已逾期
  currency: string;
  orderAmount: number;
}

// ── B2 缺口补全：样品进度预警 ──
export interface SampleProgressAlert {
  caseId: string;
  caseCode: string;
  caseName: string;
  stage: string;
  priority: string;
  customerName: string | null;
  productName: string | null;
  currentRound: number;
  targetDate: string | null;
  daysOverdue: number | null; // targetDate 已过且未完成 → 正数
  pendingSampleLevel: string | null;
  pendingSampleStatus: string | null;
}

// ── B2 缺口补全：汇率走势趋势 ──
export interface FxTrendPoint {
  currency: string;
  effectiveDate: string;
  rate: number;
}

export interface FxTrend {
  baseCurrency: string;
  points: FxTrendPoint[];
}

export interface BusinessCockpit {
  from: string | null;
  to: string | null;
  generatedAt: string; // ISO
  salesLeaderboard: SalesLeaderboardRow[];
  customerContribution: CustomerContributionRow[];
  orderMargins: { rows: OrderMarginRow[]; totals: OrderMarginTotal[]; excludedCount: number };
  orderStatusDistribution: OrderStatusBucket[];
  deliveryAlerts: DeliveryAlert[];
  sampleProgressAlerts: SampleProgressAlert[];
  fxTrend: FxTrend;
  /**
   * ★ 应收应付逾期预警。
   *
   * ⚠️ **不遮罩（业务方 2026-09-17 确认的口径，口径 B2）**：任何能进驾驶舱的人都能看，
   *    含业务员。这**不是缺陷、不要"修"** —— 曾有人提议按 `ar:read` 遮罩，
   *    业务方明确答复「两块都不遮」。见 `docs/业务口径决策单-2026-09-17.md` B2。
   */
  arApAlerts: {
    receivable: { rows: AgingRow[]; totals: ArApAlertBucket[] };
    payable: { rows: AgingRow[]; totals: ArApAlertBucket[] };
  };
  /**
   * ★ 汇兑损益汇总。
   *
   * ⚠️ **不遮罩（业务方 2026-09-17 确认的口径，口径 B2）**：同上 ——
   *    **不要**去定义 `fx:read` 或给它加遮罩。见决策单 B2。
   */
  fxSummary: { baseCurrency: string; totalGainLoss: number; rowCount: number };
}

// ────────────────────────────────────────────────────────────────
// 实现
// ────────────────────────────────────────────────────────────────

const UNASSIGNED = '未分配';

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function overdueOf(row: AgingRow): number {
  return round4(row.buckets.d1_30 + row.buckets.d31_60 + row.buckets.d61_90 + row.buckets.d90plus);
}

// ────────────────────────────────────────────────────────────────
// ★ B2（2026-09-18）：跨币种毛利 —— 成本折收入币种
// ────────────────────────────────────────────────────────────────

interface FxContext {
  /** 锁汇： `${orderId}::${CURRENCY}` → 锁定汇率（1 外币 = ? CNY） */
  locks: Map<string, number>;
  /** 市场汇率档案（全表，按币种+日期在内存里挑，避免逐单查库） */
  marketRows: Array<{ currency: string; rate: number; effectiveDate: string | null }>;
}

const salesCcyOf = (o: any): string => (o?.salesCurrency ?? o?.currency ?? 'USD') as string;
const purchaseCcyOf = (o: any): string => (o?.purchaseCurrency ?? salesCcyOf(o)) as string;
const costOfOrder = (o: any): number | null =>
  num(o?.supplierInvoiceAmount)
  ?? (num(o?.purchasePrice) != null ? round4(num(o!.purchasePrice)! * Number(o?.quantity ?? 0)) : null);

/**
 * 只为「跨币种 + 有成本」的订单预取锁汇与市场汇率。
 * 为什么先过滤：毛利表动辄上百单，绝大多数是同币种 —— 逐单查锁汇/汇率表纯属浪费。
 */
async function buildFxContext(prisma: PrismaClient, orders: any[]): Promise<FxContext> {
  const need = orders.filter(o => costOfOrder(o) != null && purchaseCcyOf(o) !== salesCcyOf(o));
  if (need.length === 0) return { locks: new Map(), marketRows: [] };

  const locks = new Map<string, number>();
  const lockRows: Array<{ orderId: string; currency: string; rate: unknown }> =
    await (prisma as any).fxRateLock.findMany({
      where: { orderId: { in: need.map(o => o.id) }, deletedAt: null },
      select: { orderId: true, currency: true, rate: true },
    }).catch(() => [] as any[]);
  for (const r of lockRows ?? []) {
    const rate = Number(r?.rate);
    if (Number.isFinite(rate) && rate > 0) {
      locks.set(`${r.orderId}::${String(r.currency ?? '').trim().toUpperCase()}`, rate);
    }
  }

  const rateRows: Array<{ currency: string; rate: unknown; effectiveDate: string | null }> =
    await (prisma as any).exchangeRate.findMany({
      select: { currency: true, rate: true, effectiveDate: true },
    }).catch(() => [] as any[]);

  return {
    locks,
    marketRows: (rateRows ?? []).map(r => ({
      currency: String(r?.currency ?? ''),
      rate: Number(r?.rate),
      effectiveDate: r?.effectiveDate ?? null,
    })).filter(r => Number.isFinite(r.rate) && r.rate > 0),
  };
}

function alertTotals(rows: AgingRow[]): ArApAlertBucket[] {
  const map = new Map<string, ArApAlertBucket>();
  for (const row of rows) {
    let t = map.get(row.currency);
    if (!t) { t = { currency: row.currency, overdue: 0, total: 0 }; map.set(row.currency, t); }
    t.overdue = round4(t.overdue + overdueOf(row));
    t.total = round4(t.total + row.buckets.total);
  }
  // ★ 只保留**确有逾期**的币种。本结构是 `arApAlerts`（**预警**），不是「按币种应收/应付汇总」：
  //   旧实现把 `overdue = 0` 的币种也留下 ⇒ ① 前端渲染成「● ¥0.00」——
  //   **红色危险点配零**，视觉上像"有逾期"；② 前端「无逾期」空态的判据是
  //   `rows.length === 0`（**没有任何币种**）⇒ 只要存在「有应收但未逾期」的币种，
  //   空态**永不触发**，用户看到的是 `¥0.00` 而不是「无逾期」。
  //   消费方核对（2026-09-17）：`briefingService` 与 `CockpitManager` **都只读 `overdue`**，
  //   无消费方依赖「overdue=0 的桶」或依赖该桶的 `total` ⇒ 过滤安全。
  return [...map.values()]
    .filter(t => t.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue);
}

/**
 * 订单级实收聚合（财务核销链真源，2026-09-02 回款口径切换）：
 *   收款真源 = Σ InvoiceAllocation.appliedAmount（与 reconciliationService 拍板③同源），
 *   仅统计 Receipt 凭证 × Receivable 未作废发票；InvoiceAllocation 为硬删除模型无软删过滤。
 *   订单归属：InvoiceOrderAllocation 分摊优先（allocatedAmount ?? invoice.amount 加权，
 *   与开票口径一致），无分摊行时回退 Invoice.orderId 直挂。
 *   币种诚实：按发票币种入账；消费方只在「发票币种 === 订单销售币种」时并入回款行
 *   （跨币种不折算，与毛利口径一致）。
 * @returns orderId → (invoiceCurrency → paidAmount)
 */
export async function collectOrderReceipts(
  prisma: PrismaClient,
): Promise<Map<string, Map<string, number>>> {
  const [invoices, ioaRows, receiptVouchers, allocRows] = await Promise.all([
    prisma.invoice.findMany({
      where: { type: 'Receivable', status: { not: 'Cancelled' }, deletedAt: null },
      select: { id: true, orderId: true, amount: true, currency: true },
    }),
    prisma.invoiceOrderAllocation.findMany({
      where: { deletedAt: null },
      select: { invoiceId: true, orderId: true, allocatedAmount: true },
    }),
    prisma.paymentVoucher.findMany({
      where: { type: 'Receipt', deletedAt: null },
      select: { id: true },
    }),
    prisma.invoiceAllocation.findMany({
      select: { invoiceId: true, voucherId: true, appliedAmount: true },
    }),
  ]);

  const receiptIds = new Set(receiptVouchers.map(v => v.id));
  const paidPerInvoice = new Map<string, number>();
  for (const a of allocRows) {
    if (!receiptIds.has(a.voucherId)) continue;
    paidPerInvoice.set(a.invoiceId, (paidPerInvoice.get(a.invoiceId) ?? 0) + Number(a.appliedAmount));
  }

  const ioaByInvoice = new Map<string, { orderId: string; allocatedAmount: unknown }[]>();
  for (const r of ioaRows) {
    const list = ioaByInvoice.get(r.invoiceId) ?? [];
    list.push(r);
    ioaByInvoice.set(r.invoiceId, list);
  }

  const result = new Map<string, Map<string, number>>();
  const credit = (orderId: string, currency: string, amount: number) => {
    let curMap = result.get(orderId);
    if (!curMap) { curMap = new Map(); result.set(orderId, curMap); }
    curMap.set(currency, (curMap.get(currency) ?? 0) + amount);
  };

  for (const inv of invoices) {
    const paid = paidPerInvoice.get(inv.id) ?? 0;
    if (paid <= 0) continue;
    const rows = ioaByInvoice.get(inv.id);
    if (rows && rows.length > 0) {
      const weights = rows.map(r => Number(r.allocatedAmount ?? inv.amount));
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      if (totalWeight > 0) {
        rows.forEach((r, i) => credit(r.orderId, inv.currency, (paid * weights[i]) / totalWeight));
        continue;
      }
    }
    if (inv.orderId) credit(inv.orderId, inv.currency, paid);
  }
  return result;
}

export async function getBusinessCockpit(
  prisma: PrismaClient,
  params: { actor?: TokenPayload; from?: string; to?: string; marginRowLimit?: number; orderScopeWhere?: Record<string, unknown> } = {},
): Promise<BusinessCockpit> {
  const { from, to } = params;
  const marginRowLimit = Math.min(Math.max(params.marginRowLimit ?? 100, 1), 500);

  // 三档数据范围（§10.4.2）：scopeWhere 缺省 undefined = 不受限（owner 全档）；
  // 数组白名单（可能为空 = 一张都看不到）以 id IN 叠加。此前取数无范围 → 业务员看到全公司毛利/回款（越权）。
  const scope = params.orderScopeWhere;
  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      ...(from || to
        ? { dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...(Array.isArray((scope as any)?.id?.in)
        ? { id: { in: (scope as any).id.in } }
        : scope && Object.keys(scope).length > 0 ? scope : {}),
    },
    select: {
      id: true, poNumber: true, customer: true, product: true, salesPerson: true,
      dueDate: true, status: true, quantity: true,
      currency: true, salesCurrency: true, purchaseCurrency: true,
      quoteAmount: true, contractAmount: true, shipmentAmount: true,
      // ★ 订单金额真源 orderAmountOf 需要 totalNet（≡ Σ明细行 netValue）
      totalNet: true,
      actualPaymentAmount: true, purchasePrice: true, supplierInvoiceAmount: true,
      customerRelationId: true,
    },
  });

  // ── 订单级实收（财务核销链真源，见 collectOrderReceipts 口径注释） ──
  const orderReceipts = await collectOrderReceipts(prisma);

  // ── ★ B2（2026-09-18）：跨币种毛利的汇率准备 ──
  // 采销币种不一致时**不再放弃算毛利**，而是把成本折成收入币种（真源 finance/crossCurrency）。
  // 只给「确实跨币种且有成本」的订单取数，避免每单都查锁汇/汇率表。
  const fxCtx = await buildFxContext(prisma, orders);

  // ── 1. 销售业绩排行（按 salesPerson × currency） ──
  const salesMap = new Map<string, SalesLeaderboardRow>();
  // ── 2. 客户贡献度（按 customer × currency） ──
  const custMap = new Map<string, CustomerContributionRow>();
  const custCurrencyTotals = new Map<string, number>();
  // ── 3. 订单毛利表 ──
  const marginRows: OrderMarginRow[] = [];

  for (const o of orders) {
    // ★ 订单金额 = 唯一真源 orderAmountOf（Kevin 2026-09-18 拍板：以明细行为准）
    const salesAmount = orderAmountOf(o);
    const salesCurrency = o.salesCurrency ?? o.currency ?? 'USD';
    const salesPerson = o.salesPerson?.trim() || UNASSIGNED;
    // 实收 = 核销链按订单归属分摊后，与销售币种同币种的部分（跨币种不折算）
    const collected = round4(orderReceipts.get(o.id)?.get(salesCurrency) ?? 0);

    const sKey = `${salesPerson}::${salesCurrency}`;
    let sRow = salesMap.get(sKey);
    if (!sRow) {
      sRow = { salesPerson, currency: salesCurrency, orderCount: 0, salesAmount: 0, collectedAmount: 0, collectionRate: null };
      salesMap.set(sKey, sRow);
    }
    sRow.orderCount += 1;
    sRow.salesAmount = round4(sRow.salesAmount + salesAmount);
    sRow.collectedAmount = round4(sRow.collectedAmount + collected);

    const cKey = `${o.customerRelationId ?? o.customer}::${salesCurrency}`;
    let cRow = custMap.get(cKey);
    if (!cRow) {
      cRow = {
        customer: o.customer, customerRelationId: o.customerRelationId,
        currency: salesCurrency, orderCount: 0, salesAmount: 0, share: 0,
        isNewCustomer: false, lastOrderDate: null,
      };
      custMap.set(cKey, cRow);
    }
    cRow.orderCount += 1;
    cRow.salesAmount = round4(cRow.salesAmount + salesAmount);
    // lastOrderDate = 区间内最近 dueDate
    if (o.dueDate && (!cRow.lastOrderDate || o.dueDate > cRow.lastOrderDate)) {
      cRow.lastOrderDate = o.dueDate;
    }
    custCurrencyTotals.set(salesCurrency, round4((custCurrencyTotals.get(salesCurrency) ?? 0) + salesAmount));

    // 毛利
    // 收入（毛利口径）：已出运则按出运金额确认 —— 这个「出运优先」是业务语义，**保留**；
    // 未出运时回退订单金额，必须走唯一真源（不能再写 contractAmount ?? quoteAmount）。
    const revenue = num(o.shipmentAmount) ?? orderAmountOf(o);
    const purchaseCurrency = o.purchaseCurrency ?? salesCurrency;
    const cost = num(o.supplierInvoiceAmount)
      ?? null; // No verified price-unit scope: never derive cost from a nullable/mixed header.
    const crossCurrency = cost != null && purchaseCurrency !== salesCurrency;

    // ★ B2：跨币种 → 把成本折成收入币种再算（真源 finance/crossCurrency.convertViaCny）
    let costInSalesCurrency: number | null = cost != null ? round4(cost) : null;
    let fxRate: number | null = null;
    let fxRateSource: 'lock' | 'market' | 'mixed' | null = null;
    if (crossCurrency && cost != null) {
      const fromKey = `${o.id}::${String(purchaseCurrency).trim().toUpperCase()}`;
      const toKey = `${o.id}::${String(salesCurrency).trim().toUpperCase()}`;
      const fromRate = fxCtx.locks.get(fromKey) ?? pickRateOn(fxCtx.marketRows, purchaseCurrency, o.dueDate);
      const toRate = fxCtx.locks.get(toKey) ?? pickRateOn(fxCtx.marketRows, salesCurrency, o.dueDate);
      const conv = convertViaCny(cost, purchaseCurrency, salesCurrency, {
        [String(purchaseCurrency).trim().toUpperCase()]: fromRate,
        [String(salesCurrency).trim().toUpperCase()]: toRate,
      });
      if (conv) {
        costInSalesCurrency = conv.amount;
        fxRate = conv.rate;
        // 来源判定只数**外币侧**：CNY 是折算基准（rate 恒为 1，不存在也不需要锁汇），
        // 否则「销售美元锁汇、采购人民币」会被误标成 mixed（明明整笔都用锁定汇率）。
        const fromIsCny = String(purchaseCurrency).trim().toUpperCase() === 'CNY';
        const toIsCny = String(salesCurrency).trim().toUpperCase() === 'CNY';
        const foreignSides = (fromIsCny ? 0 : 1) + (toIsCny ? 0 : 1);
        const lockSides = (fromIsCny ? 0 : (fxCtx.locks.has(fromKey) ? 1 : 0))
          + (toIsCny ? 0 : (fxCtx.locks.has(toKey) ? 1 : 0));
        fxRateSource = lockSides === 0 ? 'market' : (lockSides === foreignSides ? 'lock' : 'mixed');
      } else {
        // 汇率缺失 → 明确不折算（不猜），成本列显示「无法折算」而不是 0
        costInSalesCurrency = null;
      }
    }

    const margin = costInSalesCurrency != null ? round4(revenue - costInSalesCurrency) : null;
    const marginRate = margin != null && revenue > 0 ? round4(margin / revenue) : null;
    const collectionRate = revenue > 0 ? round4(collected / revenue) : null;
    marginRows.push({
      orderId: o.id, poNumber: o.poNumber, customer: o.customer, product: o.product,
      salesPerson: o.salesPerson, dueDate: o.dueDate, status: o.status,
      currency: salesCurrency, revenue: round4(revenue),
      cost: cost != null ? round4(cost) : null,
      costInSalesCurrency,
      purchaseCurrency: cost != null ? purchaseCurrency : null,
      crossCurrency, fxRate, fxRateSource,
      margin, marginRate, collectionRate,
    });
  }

  // 贡献度占比（同币种内）
  for (const row of custMap.values()) {
    const total = custCurrencyTotals.get(row.currency) ?? 0;
    row.share = total > 0 ? round4(row.salesAmount / total) : 0;
  }

  const salesLeaderboard = [...salesMap.values()]
    .sort((a, b) => b.salesAmount - a.salesAmount);
  // collectionRate = collectedAmount / salesAmount
  for (const row of salesLeaderboard) {
    row.collectionRate = row.salesAmount > 0 ? round4(row.collectedAmount / row.salesAmount) : null;
  }

  const customerContribution = [...custMap.values()]
    .sort((a, b) => b.salesAmount - a.salesAmount);

  // ── isNewCustomer：查询区间之前的订单，标记客户是否为新区间首单 ──
  if (from) {
    const priorOrders = await prisma.order.findMany({
      where: { deletedAt: null, dueDate: { lt: from } },
      select: { customerRelationId: true, customer: true },
    });
    const priorCustomerKeys = new Set<string>();
    for (const p of priorOrders) {
      priorCustomerKeys.add(p.customerRelationId ?? p.customer ?? '');
    }
    for (const row of customerContribution) {
      const key = row.customerRelationId ?? row.customer ?? '';
      row.isNewCustomer = !priorCustomerKeys.has(key);
    }
  }

  // 毛利合计（成本齐备 + 能折到收入币种的订单计入）
  // ★ B2：跨币种订单不再被整体排除 —— 折算后的成本（costInSalesCurrency）已与收入同币种，
  //   可以按收入币种正常合计。此前 `|| row.crossCurrency` 会让「收美元付人民币」这类
  //   最常见的外贸单**永远不进合计**（老板看到的毛利合计系统性偏乐观）。
  //（内部累加器非空，出口类型 OrderMarginTotal 的 null 留给 sensitiveMask 遮罩）
  const marginTotalMap = new Map<string, { currency: string; revenue: number; cost: number; margin: number; orderCount: number }>();
  let excluded = 0;
  for (const row of marginRows) {
    if (row.margin == null || row.costInSalesCurrency == null) { excluded++; continue; }
    let t = marginTotalMap.get(row.currency);
    if (!t) {
      t = { currency: row.currency, revenue: 0, cost: 0, margin: 0, orderCount: 0 };
      marginTotalMap.set(row.currency, t);
    }
    t.revenue = round4(t.revenue + row.revenue);
    t.cost = round4(t.cost + row.costInSalesCurrency);
    t.margin = round4(t.margin + row.margin);
    t.orderCount += 1;
  }
  const marginTotals: OrderMarginTotal[] = [...marginTotalMap.values()].map(t => ({
    ...t,
    marginRate: t.revenue > 0 ? round4(t.margin / t.revenue) : null,
  }));

  // 毛利行排序：亏损订单靠前暴露问题（margin 升序），无毛利数据的排最后按收入降序
  marginRows.sort((a, b) => {
    if (a.margin == null && b.margin == null) return b.revenue - a.revenue;
    if (a.margin == null) return 1;
    if (b.margin == null) return -1;
    return a.margin - b.margin;
  });
  const trimmedMarginRows = marginRows.slice(0, marginRowLimit);

  // ── B2 缺口：订单状态分布卡（按 status × currency 分组） ──
  const statusMap = new Map<string, OrderStatusBucket>();
  for (const o of orders) {
    // ★ 订单金额 = 唯一真源 orderAmountOf（Kevin 2026-09-18 拍板：以明细行为准）
    const salesAmount = orderAmountOf(o);
    const salesCurrency = o.salesCurrency ?? o.currency ?? 'USD';
    const key = `${o.status}::${salesCurrency}`;
    let bucket = statusMap.get(key);
    if (!bucket) {
      bucket = { status: o.status, count: 0, salesAmount: 0, currency: salesCurrency };
      statusMap.set(key, bucket);
    }
    bucket.count += 1;
    bucket.salesAmount = round4(bucket.salesAmount + salesAmount);
  }
  const orderStatusDistribution = [...statusMap.values()]
    .sort((a, b) => b.count - a.count);

  // ── B2 缺口：交付预警（未完结订单 + dueDate 在 7 天内或已逾期） ──
  // null 交期不进预警：原「取今天」口径会把无交期订单伪装成 0 天伪紧急
  const todayStr = todayLocalKey();
  const TERMINAL_STATUSES = new Set(['Delivered', 'Shipped', 'Cancelled', 'Closed']);
  const deliveryAlerts: DeliveryAlert[] = orders
    .filter(o => !TERMINAL_STATUSES.has(o.status) && o.dueDate != null)
    .map(o => {
      const dueDate = o.dueDate!;
      const daysDiff = Math.floor((new Date(dueDate).getTime() - new Date(todayStr).getTime()) / 86400000);
      return {
        orderId: o.id,
        poNumber: o.poNumber,
        customer: o.customer,
        product: o.product,
        dueDate,
        status: o.status,
        daysUntilDue: daysDiff,
        currency: o.salesCurrency ?? o.currency ?? 'USD',
        orderAmount: orderAmountOf(o), // ★ 唯一真源
      };
    })
    .filter(a => a.daysUntilDue <= 7) // 7 天内到期或已逾期
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  // ── 4. 应收应付预警（复用 B2 账龄，取逾期行 Top5） ──
  const [arAging, apAging, devCases, fxRates] = await Promise.all([
    getAgingReport(prisma, { actor: params.actor, type: 'Receivable' }),
    getAgingReport(prisma, { actor: params.actor, type: 'Payable' }),
    // B2 缺口：样品进度预警 — 查询活跃样衣案件
    prisma.developmentCase.findMany({
      where: {
        deletedAt: null,
        stage: { notIn: ['approved', 'cancelled'] },
      },
      select: {
        id: true, code: true, name: true, stage: true, priority: true,
        customerName: true, productName: true, currentRound: true,
        targetDate: true, completedDate: true,
      },
    }).catch(() => [] as any[]),
    // B2 缺口：汇率走势趋势 — 查询近期汇率记录
    prisma.exchangeRate.findMany({
      orderBy: { effectiveDate: 'desc' },
      take: 30,
      select: { currency: true, rate: true, effectiveDate: true },
    }).catch(() => [] as any[]),
  ]);

  const arAlertRows = arAging.rows.filter(r => overdueOf(r) > 0)
    .sort((a, b) => overdueOf(b) - overdueOf(a)).slice(0, 5);
  const apAlertRows = apAging.rows.filter(r => overdueOf(r) > 0)
    .sort((a, b) => overdueOf(b) - overdueOf(a)).slice(0, 5);

  // ── B2 缺口：样品进度预警 ──
  const sampleProgressAlerts: SampleProgressAlert[] = devCases
    .map((c: any) => {
      const daysOverdue = c.targetDate && !c.completedDate
        ? Math.max(0, Math.floor((new Date(todayStr).getTime() - new Date(c.targetDate).getTime()) / 86400000))
        : null;
      return {
        caseId: c.id,
        caseCode: c.code,
        caseName: c.name,
        stage: c.stage,
        priority: c.priority,
        customerName: c.customerName ?? null,
        productName: c.productName ?? null,
        currentRound: c.currentRound ?? 1,
        targetDate: c.targetDate ?? null,
        daysOverdue,
        pendingSampleLevel: null,
        pendingSampleStatus: null,
      };
    })
    .filter(a => a.daysOverdue != null && a.daysOverdue > 0)
    .sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0));

  // ── B2 缺口：汇率走势趋势（近 30 条，按日期升序排列供前端折线图） ──
  const fxTrendPoints: FxTrendPoint[] = (fxRates as any[])
    .map(r => ({ currency: r.currency, effectiveDate: r.effectiveDate, rate: Number(r.rate) }))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const fxTrend: FxTrend = { baseCurrency: 'CNY', points: fxTrendPoints };

  // ── 5. 汇率损益汇总（复用 B2） ──
  const fx = await getFxGainLoss(prisma, { from, to, actor: params.actor });

  return {
    from: from ?? null,
    to: to ?? null,
    generatedAt: new Date().toISOString(),
    salesLeaderboard,
    customerContribution,
    orderMargins: { rows: trimmedMarginRows, totals: marginTotals, excludedCount: excluded },
    orderStatusDistribution,
    deliveryAlerts,
    sampleProgressAlerts,
    fxTrend,
    arApAlerts: {
      receivable: { rows: arAlertRows, totals: alertTotals(arAging.rows) },
      payable: { rows: apAlertRows, totals: alertTotals(apAging.rows) },
    },
    fxSummary: { baseCurrency: fx.baseCurrency, totalGainLoss: fx.totalGainLoss, rowCount: fx.rows.length },
  };
}
