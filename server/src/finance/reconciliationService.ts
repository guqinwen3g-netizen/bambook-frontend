/**
 * reconciliationService.ts — W-B 波次 P2-6 客户四单对账引擎（订单 ↔ 出运 ↔ 开票 ↔ 收款）
 *
 * 开工前已拍板的 3 个跨域契约断层（docs/README.md W-0 节，2026-08-27）：
 *   ① InvoiceOrderAllocation.batchId 无任何写入入口（分批开票未启用）：
 *      本引擎按**整单口径**聚合开票金额——IOA.allocatedAmount 现恒为 null → 取 invoice.amount 全额。
 *      ⚠️ 待分批开票启用后必须补 batchId 维度（按批次拆分 invoiced/paid，与本引擎的订单级口径并存）。
 *   ② 币种双源（Order.currency vs salesCurrency ?? purchaseCurrency）：
 *      订单侧真源统一为 Order.currency；发票侧真源为 Invoice.currency。
 *      两者不一致时记 currency_mismatch 差异，**不静默取其一**。
 *   ③ Order.actualPaymentAmount 是手工 PATCH 字段，财务核销不回写：
 *      收款真源 = Σ InvoiceAllocation.appliedAmount；actualPaymentAmount 仅作参考字段，
 *      与真源不一致时记 manual_payment_field_drift 差异（info），建议后续废弃该手工字段。
 *
 * 口径说明：
 *   - 订单金额：Order.totalNet ?? quoteAmount（与 orderShipmentBatchService.orderAmountOf 同口径）
 *   - 订单数量：Σ OrderLine.quantity；无行时回退 Order.quantity
 *   - 出运数量：优先 Σ ShipmentOrderAllocation.actualQty（DR-016，限已发运+运单）；
 *     无分配行时回退 Σ ShipmentLine.quantity（经 orderLineId ∈ 订单行 关联，限已发运+运单）。
 *     已发运+ = Shipped | Arrived | Cleared | Delivered；Cancelled 运单恒排除。
 *   - 开票金额：Σ (IOA.allocatedAmount ?? Invoice.amount)，type=Receivable 且未作废；
 *     关联路径 = InvoiceOrderAllocation(orderId) ∪ Invoice.orderId 直挂（按发票 id 去重，IOA 分摊额优先）。
 *   - 收款金额：Σ InvoiceAllocation.appliedAmount（硬删除模型，无软删过滤）。
 *
 * 纯只读：不写库、不触发任何状态重算；所有金额用 Prisma.Decimal 累加避免 IEEE 754 漂移。
 *
 * P2-7 多币种扩展（fxReconciliationService 为汇率链唯一计算真源）：
 *   - 单订单结果补 fxDiscrepancies + fx（三段汇率链对照 / 锁汇 / 已实现损益）
 *   - 客户汇总补 fxGainLossTotal（按币种分组：应收/锁汇覆盖/已实现损益）
 *   - 全量差异清单拍平 fx 差异（type=fx_*，支持 type=fx 聚合筛选）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { SHIPPED_SHIPMENT_STATUSES } from '../shared/shippingLock';
import {
  reconcileOrderFx,
  type FxDiscrepancy,
  type OrderFxReconciliation,
} from './fxReconciliationService';
import { orderAmountOf } from '../shared/orderAmount';

export type DiscrepancySeverity = 'critical' | 'warning' | 'info';

/**
 * T7-① 按币种分组的金额行（口径 A，2026-09-16 业务方拍板）。
 *
 * 铁律：**跨币种绝不合并**——「USD 10000 + CNY 5000 = 15000」是没有货币含义的数字，
 * 拿它去和订单额比还会产出假的「超开/超收 critical」，直接误导财务。
 * 合并只在**同币种内**进行；跨币种时对外暴露 null + 本结构的分币种明细。
 */
export interface CurrencyAmount {
  currency: string;
  amount: number;
}

export interface ReconciliationDiscrepancy {
  type:
    | 'quantity_mismatch'        // 出运量 ≠ 订单量（超发 critical；已交付未足量 warning）
    | 'invoice_amount_mismatch'  // 开票 ≠ 订单额（超开 critical；未开票余额 info/warning）
    | 'payment_mismatch'         // 收款 ≠ 开票（超收 critical；未收款余额 info/warning）
    | 'status_inconsistency'     // 状态链断裂（已交付无票/已付未交付等）
    | 'currency_mismatch'        // 订单/发票币种两两不同
    | 'manual_payment_field_drift' // actualPaymentAmount 手工字段与核销真源漂移
    | 'fx_order_to_invoice'      // P2-7 汇率链 A 段：开票汇率 vs 期望（锁定/市场）
    | 'fx_invoice_to_payment'    // P2-7 汇率链 B 段：收付汇率 vs 开票汇率（已实现损益）
    | 'fx_payment_to_settlement'; // P2-7 汇率链 C 段：结汇汇率 vs 收付汇率（已实现损益）
  field: string;
  expected: string;
  actual: string;
  severity: DiscrepancySeverity;
  message: string;
}

export interface ReconcileOrderResult {
  orderId: string;
  orderCode: string | null;
  poNumber: string | null;
  customerName: string | null;
  customerRelationId: string | null;
  currency: string | null;          // 订单侧币种真源（Order.currency）
  orderAmount: number;              // totalNet ?? quoteAmount
  orderStatus: string;
  orderedQty: number;
  shippedQty: number;
  delivered: boolean;               // 是否存在 Delivered 运单
  /**
   * T7-①：**只在同币种内合并**。全部同币种（或为空）→ 等于该币种金额；跨币种 → **null**
   * （绝不返回无意义总和）。分币种明细见 invoicedByCurrency / paidByCurrency。
   */
  invoicedAmount: number | null;
  paidAmount: number | null;
  invoicedByCurrency: CurrencyAmount[];   // 按币种分组的开票额（金额真源）
  paidByCurrency: CurrencyAmount[];       // 按币种分组的收款额（金额真源）
  invoiceCount: number;
  /** T7-① 口径 A-2/A-3：已结汇部分按**结汇汇率**折算的 CNY 合计（未结汇不计入，不做任何估算折算） */
  settledCny: number;
  /**
   * T7-④ 口径延伸：「出口单含退税再累加」属**对账层面** —— 已退税 CNY（只算 status='Refunded' 的，
   * 不预提，与 A-3「已结汇才锁定」同精神）。
   * 实际回笼资金 = settledCny + refundedCny（前端「已回笼(CNY)」格）。
   */
  refundedCny: number;
  referenceActualPaymentAmount: number | null; // 手工字段快照（仅参考，见拍板③）
  discrepancies: ReconciliationDiscrepancy[];
  fxDiscrepancies: FxDiscrepancy[];       // P2-7 汇率链显著差异（锁汇优先）
  fx: OrderFxReconciliation;              // P2-7 三段对照 + 锁汇 + 已实现损益（纯 CNY 订单 segments 为空）
}

/** P2-7 客户维度多币种汇总行（按币种分组） */
export interface CustomerFxCurrencySummary {
  currency: string;
  invoicedAmount: number;      // 外币应收总额（发票）
  lockedAmount: number;        // 其中锁汇覆盖金额（FxRateLock active 的订单）
  coveragePct: number;         // lockedAmount / invoicedAmount（0-1）
  realizedGainLossCny: number; // 已实现汇兑损益（B+C 段合计，CNY）
}

/** T7-① 客户维度按币种分组的三档金额（跨币种不合并的真源） */
export interface CustomerCurrencyTotals {
  currency: string;
  orderAmount: number;
  invoicedAmount: number;
  paidAmount: number;
}

export interface CustomerReconciliationSummary {
  customerRelationId: string;
  totalOrders: number;
  discrepancyOrders: number;
  /** T7-①：客户下订单币种唯一（或全空）时才有值；**跨币种 → null**（用 totalByCurrency） */
  totalOrderAmount: number | null;
  totalInvoicedAmount: number | null;
  totalPaidAmount: number | null;
  /** T7-① 按币种分组的客户汇总（金额真源；跨币种场景看这里） */
  totalByCurrency: CustomerCurrencyTotals[];
  /** T7-① 口径 A-2/A-3：已结汇按结汇汇率折算的 CNY 合计（未结汇不计入） */
  settledCnyTotal: number;
  /** T7-④ 已退税 CNY 合计（status='Refunded'）；已回笼 = settledCnyTotal + refundedCnyTotal */
  refundedCnyTotal: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  fxGainLossTotal: CustomerFxCurrencySummary[]; // P2-7 多币种汇总（按币种分组）
}

const SHIPPED_STATUSES = new Set<string>(SHIPPED_SHIPMENT_STATUSES); // 收口到 shared/shippingLock
const EPS = new Prisma.Decimal('0.0001');

function dec(v: unknown): Prisma.Decimal {
  if (v === null || v === undefined) return new Prisma.Decimal(0);
  try { return new Prisma.Decimal(v as any); } catch { return new Prisma.Decimal(0); }
}

function d2n(d: Prisma.Decimal): number {
  return Number(d.toFixed(4));
}

/** number 版 round4（与 fxReconciliationService 同口径，避免 IEEE 754 尾差） */
function round4n(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 未标币种的兜底桶（不猜币种，显式可见） */
const UNKNOWN_CURRENCY = '(未标币种)';

/**
 * T7-①：单币种才可合并——空 map → 0（确实没有金额），单币种 → 该币种金额，**跨币种 → null**。
 * 返回 null 是刻意的：宁可让调用方显示「—」，也不给一个没有货币含义的总和
 * （旧实现「USD 10000 + CNY 5000 = 15000」再拿去比订单额，会产出假的超开/超收 critical）。
 */
function soleCurrencyAmount(map: Map<string, Prisma.Decimal>): number | null {
  if (map.size === 0) return 0;
  if (map.size === 1) return d2n([...map.values()][0]);
  return null;
}

/** Map<币种, Decimal> → 对外分币种明细（按币种字典序，稳定输出） */
function toCurrencyAmounts(map: Map<string, Prisma.Decimal>): CurrencyAmount[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, d]) => ({ currency, amount: d2n(d) }));
}

const SEVERITY_RANK: Record<DiscrepancySeverity, number> = { critical: 0, warning: 1, info: 2 };

export function sortDiscrepancies<T extends { severity: DiscrepancySeverity }>(list: T[]): T[] {
  return [...list].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * 单订单四单勾稽。订单不存在/已软删返回 null（由路由层转 404）。
 */
export async function reconcileOrder(prisma: PrismaClient, orderId: string): Promise<ReconcileOrderResult | null> {
  const db = prisma as any;

  // ── 订单侧 ────────────────────────────────────────────────
  const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
  if (!order) return null;
  // ★ 订单金额唯一真源（Kevin 2026-09-18 拍板：以明细行为准）
  //   真源返回 number，此处仍转成 Decimal —— 下游四单勾稽全程按 Decimal 运算，不变其语义。
  const orderAmount = dec(orderAmountOf(order));
  // 拍板②：订单侧币种真源 = Order.currency（不回退 salesCurrency/purchaseCurrency，避免双源静默漂移）
  const orderCurrency: string | null = order.currency ?? null;

  const orderLines: any[] = await db.orderLine.findMany({ where: { orderId } });
  const orderedQty = orderLines.length > 0
    ? orderLines.reduce((sum: Prisma.Decimal, l: any) => sum.plus(dec(l.quantity)), new Prisma.Decimal(0))
    : dec(order.quantity);
  const orderLineIds = new Set(orderLines.map((l: any) => l.id));

  // ── 出运侧 ────────────────────────────────────────────────
  // 关联路径：ShipmentOrderAllocation(orderId)（DR-016 真源）∪ Shipment.orderId 投影（兼容旧数据）
  const shipmentAllocRows: any[] = await db.shipmentOrderAllocation.findMany({ where: { orderId } });
  const allocShipmentIds = [...new Set(shipmentAllocRows.map((a: any) => a.shipmentId))] as string[];
  const projectionShipments: any[] = await db.shipment.findMany({ where: { orderId, deletedAt: null } });
  const shipmentIds = [...new Set([...allocShipmentIds, ...projectionShipments.map((s: any) => s.id)])] as string[];
  const shipments: any[] = shipmentIds.length > 0
    ? await db.shipment.findMany({ where: { id: { in: shipmentIds }, deletedAt: null } })
    : [];
  const activeShipments = shipments.filter((s: any) => s.status !== 'Cancelled');
  const shippedShipments = activeShipments.filter((s: any) => SHIPPED_STATUSES.has(s.status));
  const shippedShipmentIds = new Set(shippedShipments.map((s: any) => s.id));
  const delivered = activeShipments.some((s: any) => s.status === 'Delivered');

  let shippedQty = new Prisma.Decimal(0);
  const allocRowsOnShipped = shipmentAllocRows.filter((a: any) => shippedShipmentIds.has(a.shipmentId));
  if (allocRowsOnShipped.length > 0) {
    // DR-016 分配表口径：actualQty（发货确认回填）；actualQty 缺省回退 plannedQty
    for (const a of allocRowsOnShipped) {
      shippedQty = shippedQty.plus(dec(a.actualQty ?? a.plannedQty));
    }
  } else if (shippedShipments.length > 0) {
    // 回退口径：ShipmentLine.quantity（经 orderLineId ∈ 订单行；行无 orderLineId 时若运单投影挂本订单则计入）
    const projectionShippedIds = new Set(
      shippedShipments.filter((s: any) => s.orderId === orderId).map((s: any) => s.id),
    );
    const lines: any[] = await db.shipmentLine.findMany({
      where: { shipmentId: { in: [...shippedShipmentIds] } },
    });
    for (const line of lines) {
      const belongs = (line.orderLineId && orderLineIds.has(line.orderLineId))
        || (!line.orderLineId && projectionShippedIds.has(line.shipmentId));
      if (belongs) shippedQty = shippedQty.plus(dec(line.quantity));
    }
  }

  // ── 开票侧（应收） ─────────────────────────────────────────
  // 拍板①：整单口径——IOA.allocatedAmount 现恒 null → 取 invoice.amount；
  // ⚠️ 待分批开票启用后需补 batchId 维度（按 OrderShipmentBatch 拆分勾稽）。
  const ioaRows: any[] = await db.invoiceOrderAllocation.findMany({ where: { orderId, deletedAt: null } });
  const ioaInvoiceIds = [...new Set(ioaRows.map((a: any) => a.invoiceId))] as string[];
  const directInvoices: any[] = await db.invoice.findMany({
    where: { orderId, type: 'Receivable', deletedAt: null },
  });
  const allInvoiceIds = [...new Set([...ioaInvoiceIds, ...directInvoices.map((i: any) => i.id)])] as string[];
  const invoices: any[] = allInvoiceIds.length > 0
    ? await db.invoice.findMany({ where: { id: { in: allInvoiceIds }, deletedAt: null } })
    : [];
  const validInvoices = invoices.filter((i: any) => i.type === 'Receivable' && i.status !== 'Cancelled');
  const ioaByInvoiceId = new Map<string, any>(ioaRows.map((a: any) => [a.invoiceId, a]));

  // T7-①：开票额**按币种分组**累加（金额的货币单位 = 发票自身币种）
  const invoicedByCurrencyMap = new Map<string, Prisma.Decimal>();
  for (const inv of validInvoices) {
    const ioa = ioaByInvoiceId.get(inv.id);
    // IOA 分摊额优先；缺省（null）= 整单口径取发票全额
    const amt = ioa?.allocatedAmount != null ? dec(ioa.allocatedAmount) : dec(inv.amount);
    const cur = String(inv.currency ?? '').trim() || UNKNOWN_CURRENCY;
    invoicedByCurrencyMap.set(cur, (invoicedByCurrencyMap.get(cur) ?? new Prisma.Decimal(0)).plus(amt));
  }

  // ── 收款侧 ────────────────────────────────────────────────
  // 拍板③：收款真源 = Σ InvoiceAllocation.appliedAmount（硬删除模型，无软删过滤）。
  // Order.actualPaymentAmount 仅作参考字段，见下方 manual_payment_field_drift 差异。
  // T7-①：收款额按**所属发票的币种**分组（核销金额的货币单位跟发票走）。
  const validInvoiceIds = validInvoices.map((i: any) => i.id);
  const paymentAllocs: any[] = validInvoiceIds.length > 0
    ? await db.invoiceAllocation.findMany({ where: { invoiceId: { in: validInvoiceIds } } })
    : [];
  const invoiceCurrencyById = new Map<string, string>(
    validInvoices.map((i: any) => [i.id, String(i.currency ?? '').trim() || UNKNOWN_CURRENCY]),
  );
  const paidByCurrencyMap = new Map<string, Prisma.Decimal>();
  for (const pa of paymentAllocs) {
    const cur = invoiceCurrencyById.get(pa.invoiceId) ?? UNKNOWN_CURRENCY;
    paidByCurrencyMap.set(cur, (paidByCurrencyMap.get(cur) ?? new Prisma.Decimal(0)).plus(dec(pa.appliedAmount)));
  }

  // T7-①：对外暴露「可合并值」——单币种（或空）才有值，跨币种一律 null
  const invoicedAmount = soleCurrencyAmount(invoicedByCurrencyMap);
  const paidAmount = soleCurrencyAmount(paidByCurrencyMap);
  const invoicedCurrencies = [...invoicedByCurrencyMap.keys()];
  const paidCurrencies = [...paidByCurrencyMap.keys()];

  // ── 差异判定 ───────────────────────────────────────────────
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const push = (d: ReconciliationDiscrepancy) => discrepancies.push(d);
  const orderStatus: string = order.status;

  // 币种不一致（拍板②：订单/发票两两比对，不静默取其一）
  // T7-① 升级为 **critical（阻断级）**：跨币种时金额**不再参与任何比对**
  //（旧实现照加照比 → 产出假的「超开/超收 critical」，比不报更糟）。
  if (orderCurrency) {
    const foreignCurrencies = [...new Set(validInvoices.map((i: any) => i.currency).filter((c: any) => c && c !== orderCurrency))] as string[];
    if (foreignCurrencies.length > 0) {
      push({
        type: 'currency_mismatch',
        field: 'currency',
        expected: orderCurrency,
        actual: foreignCurrencies.join('/'),
        severity: 'critical',
        message: `订单币种 ${orderCurrency} 与发票币种 ${foreignCurrencies.join('/')} 不一致，金额不做跨币种比对（请按币种分别核对）`,
      });
    }
  } else if (validInvoices.length > 0) {
    push({
      type: 'currency_mismatch',
      field: 'currency',
      expected: validInvoices[0].currency,
      actual: '(订单币种缺失)',
      severity: 'info',
      message: '订单未登记币种（Order.currency 为空），无法与发票币种勾稽',
    });
  }

  // 数量差异：超发 critical；订单已交付但未足量 warning；分批出运（未交付且 <）允许
  if (shippedQty.gt(orderedQty.plus(EPS))) {
    push({
      type: 'quantity_mismatch',
      field: 'shippedQty',
      expected: d2n(orderedQty).toString(),
      actual: d2n(shippedQty).toString(),
      severity: 'critical',
      message: `出运量 ${d2n(shippedQty)} 超过订单量 ${d2n(orderedQty)}（超发）`,
    });
  } else if (orderStatus === 'Delivered' && shippedQty.plus(EPS).lt(orderedQty)) {
    push({
      type: 'quantity_mismatch',
      field: 'shippedQty',
      expected: d2n(orderedQty).toString(),
      actual: d2n(shippedQty).toString(),
      severity: 'warning',
      message: `订单已交付但出运量 ${d2n(shippedQty)} 不足订单量 ${d2n(orderedQty)}`,
    });
  }

  // 开票差异：超开 critical；未开票余额（订单交付后 warning，否则 info 允许部分开票）
  // T7-①：**只在「开票币种 == 订单币种」且开票为单一币种时比对**。
  // 跨币种无从比较——差异已由上方 currency_mismatch(critical) 表达，这里不再产出金额差异
  //（旧实现把 USD 发票和 CNY 订单额直接比 → 假的「超开」/「未开票余额」）。
  const invoicedComparable = orderCurrency != null
    && invoicedCurrencies.length <= 1
    && (invoicedCurrencies.length === 0 || invoicedCurrencies[0] === orderCurrency);
  if (invoicedComparable) {
    const invSameCur = invoicedByCurrencyMap.get(orderCurrency!) ?? new Prisma.Decimal(0);
    if (invSameCur.gt(orderAmount.plus(EPS))) {
      push({
        type: 'invoice_amount_mismatch',
        field: 'invoicedAmount',
        expected: d2n(orderAmount).toString(),
        actual: d2n(invSameCur).toString(),
        severity: 'critical',
        message: `开票总额 ${d2n(invSameCur)} 超过订单金额 ${d2n(orderAmount)}（超开）`,
      });
    } else if (invSameCur.plus(EPS).lt(orderAmount)) {
      const open = orderAmount.minus(invSameCur);
      push({
        type: 'invoice_amount_mismatch',
        field: 'invoicedAmount',
        expected: d2n(orderAmount).toString(),
        actual: d2n(invSameCur).toString(),
        severity: orderStatus === 'Delivered' ? 'warning' : 'info',
        message: `未开票余额 ${d2n(open)}（开票 ${d2n(invSameCur)} / 订单 ${d2n(orderAmount)}）`,
      });
    }
  }

  // 收款差异：超收 critical；未收款余额（订单交付后 warning，否则 info 允许部分收款）
  // T7-①：**逐币种比对**。单币种场景与原逻辑逐字等价（含文案，回归钉）；
  // 多币种时每个币种各报一条、文案带币种前缀，绝不相加后再比。
  const paymentCurrencies = [...new Set([...invoicedCurrencies, ...paidCurrencies])].sort((a, b) => a.localeCompare(b));
  const multiCurrencyAmounts = paymentCurrencies.length > 1;
  for (const cur of paymentCurrencies) {
    const invCur = invoicedByCurrencyMap.get(cur) ?? new Prisma.Decimal(0);
    const paidCur = paidByCurrencyMap.get(cur) ?? new Prisma.Decimal(0);
    const prefix = multiCurrencyAmounts ? `${cur} ` : '';
    if (paidCur.gt(invCur.plus(EPS))) {
      push({
        type: 'payment_mismatch',
        field: 'paidAmount',
        expected: d2n(invCur).toString(),
        actual: d2n(paidCur).toString(),
        severity: 'critical',
        message: `${prefix}收款总额 ${d2n(paidCur)} 超过开票总额 ${d2n(invCur)}（超收）`,
      });
    } else if (invCur.gt(0) && paidCur.plus(EPS).lt(invCur)) {
      const open = invCur.minus(paidCur);
      push({
        type: 'payment_mismatch',
        field: 'paidAmount',
        expected: d2n(invCur).toString(),
        actual: d2n(paidCur).toString(),
        severity: orderStatus === 'Delivered' ? 'warning' : 'info',
        message: `${prefix}未收款余额 ${d2n(open)}（已收 ${d2n(paidCur)} / 已开 ${d2n(invCur)}）`,
      });
    }
  }

  // 状态链一致性
  if (orderStatus === 'Delivered') {
    if (activeShipments.length === 0) {
      push({
        type: 'status_inconsistency',
        field: 'orderStatus',
        expected: '存在运单',
        actual: '无运单',
        severity: 'warning',
        message: '订单已交付但无任何出运记录',
      });
    }
    if (validInvoices.length === 0) {
      push({
        type: 'status_inconsistency',
        field: 'orderStatus',
        expected: '已开票',
        actual: '无应收发票',
        severity: 'warning',
        message: '订单已交付但无应收发票',
      });
    }
  }
  const hasPaidInvoice = validInvoices.some((i: any) => i.status === 'Paid');
  if (hasPaidInvoice && orderStatus !== 'Delivered') {
    push({
      type: 'status_inconsistency',
      field: 'orderStatus',
      expected: 'Delivered',
      actual: orderStatus,
      severity: 'warning',
      message: `发票已结清但订单状态为 ${orderStatus}（未交付）`,
    });
  }

  // 拍板③：手工 actualPaymentAmount 与核销真源漂移（建议废弃手工字段）
  // T7-①：手工字段是**订单币种**口径 → 只与订单币种的收款额比；收款跨币种时无可比性，跳过。
  const paidComparableWithOrder = orderCurrency != null
    && paidCurrencies.length <= 1
    && (paidCurrencies.length === 0 || paidCurrencies[0] === orderCurrency);
  if (order.actualPaymentAmount != null && paidComparableWithOrder) {
    const manual = dec(order.actualPaymentAmount);
    const paidSameCur = paidByCurrencyMap.get(orderCurrency!) ?? new Prisma.Decimal(0);
    if (manual.minus(paidSameCur).abs().gt(EPS)) {
      push({
        type: 'manual_payment_field_drift',
        field: 'actualPaymentAmount',
        expected: d2n(paidSameCur).toString(),
        actual: d2n(manual).toString(),
        severity: 'info',
        message: `手工实收字段 ${d2n(manual)} 与核销真源 ${d2n(paidSameCur)} 漂移（建议废弃 Order.actualPaymentAmount 手工 PATCH）`,
      });
    }
  }

  // ── P2-7 汇率链（fxReconciliationService 唯一真源；订单已存在，恒非 null） ──
  const fx = await reconcileOrderFx(prisma, orderId);

  // T7-① 口径 A-2/A-3：已结汇部分按**结汇汇率**折算的 CNY 合计。
  // 汇率链 C 段 = payment_to_settlement（FxChainSegmentType，fxReconciliationService.ts:38），
  // 其 documentRate 即结汇汇率快照、foreignAmount 即结汇外币额。
  // 未结汇部分**不计入**——业务方口径：已结过汇的才按结汇汇率敲定，未结汇不做任何估算折算。
  const settledCny = round4n(
    (fx?.segments ?? [])
      .filter((s) => s.stage === 'payment_to_settlement')
      .reduce((sum, s) => sum + (s.documentRate != null ? s.foreignAmount * s.documentRate : 0), 0),
  );

  // T7-④：「出口单含退税再累加」= 对账层面口径（业务方 2026-09-16 授权按行业判断）。
  // 只算**已到账**的退税（status='Refunded'），不预提 —— 预提等于拿没到手的钱做结算。
  const refundRows: any[] = await db.taxRefund.findMany({
    where: { orderId, deletedAt: null, status: 'Refunded' },
    select: { refundAmount: true },
  });
  let refundedCny = new Prisma.Decimal(0);
  for (const r of refundRows) refundedCny = refundedCny.plus(dec(r.refundAmount));

  return {
    orderId: order.id,
    orderCode: order.code ?? null,
    poNumber: order.poNumber ?? null,
    customerName: order.customer ?? null,
    customerRelationId: order.customerRelationId ?? null,
    currency: orderCurrency,
    orderAmount: d2n(orderAmount),
    orderStatus,
    orderedQty: d2n(orderedQty),
    shippedQty: d2n(shippedQty),
    delivered,
    invoicedAmount,
    paidAmount,
    invoicedByCurrency: toCurrencyAmounts(invoicedByCurrencyMap),
    paidByCurrency: toCurrencyAmounts(paidByCurrencyMap),
    invoiceCount: validInvoices.length,
    settledCny,
    refundedCny: d2n(refundedCny),
    referenceActualPaymentAmount: order.actualPaymentAmount != null ? d2n(dec(order.actualPaymentAmount)) : null,
    discrepancies: sortDiscrepancies(discrepancies),
    fxDiscrepancies: fx!.fxDiscrepancies,
    fx: fx!,
  };
}

/**
 * 客户维度批量对账：该客户（customerRelationId）全部未删订单逐单勾稽 + 汇总。
 */
export async function reconcileCustomer(
  prisma: PrismaClient,
  customerRelationId: string,
): Promise<{ summary: CustomerReconciliationSummary; orders: ReconcileOrderResult[] }> {
  const db = prisma as any;
  const orders: any[] = await db.order.findMany({
    where: { customerRelationId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
  });
  const results: ReconcileOrderResult[] = [];
  for (const o of orders) {
    const r = await reconcileOrder(prisma, o.id);
    if (r) results.push(r);
  }
  // P2-7 多币种汇总：按币种分组聚合应收 / 锁汇覆盖 / 已实现损益
  const fxByCurrency = new Map<string, CustomerFxCurrencySummary>();
  for (const r of results) {
    for (const g of r.fx.invoicedByCurrency) {
      let row = fxByCurrency.get(g.currency);
      if (!row) {
        row = { currency: g.currency, invoicedAmount: 0, lockedAmount: 0, coveragePct: 0, realizedGainLossCny: 0 };
        fxByCurrency.set(g.currency, row);
      }
      row.invoicedAmount = d2n(dec(row.invoicedAmount).plus(dec(g.amount)));
      row.lockedAmount = d2n(dec(row.lockedAmount).plus(dec(g.lockedAmount)));
    }
    for (const seg of r.fx.segments) {
      if (seg.gainLossCny == null) continue;
      let row = fxByCurrency.get(seg.currency);
      if (!row) {
        row = { currency: seg.currency, invoicedAmount: 0, lockedAmount: 0, coveragePct: 0, realizedGainLossCny: 0 };
        fxByCurrency.set(seg.currency, row);
      }
      row.realizedGainLossCny = d2n(dec(row.realizedGainLossCny).plus(dec(seg.gainLossCny)));
    }
  }
  for (const row of fxByCurrency.values()) {
    row.coveragePct = row.invoicedAmount > 0 ? d2n(dec(row.lockedAmount).div(dec(row.invoicedAmount))) : 0;
  }
  // T7-①：客户级汇总**按币种分组**（跨订单、跨币种绝不裸加）。
  // 订单额归到订单自身币种；开票/收款额归到各自明细的币种。
  const totalsByCurrency = new Map<string, { orderAmount: Prisma.Decimal; invoicedAmount: Prisma.Decimal; paidAmount: Prisma.Decimal }>();
  const bucketOf = (cur: string | null | undefined) => {
    const key = String(cur ?? '').trim() || UNKNOWN_CURRENCY;
    let b = totalsByCurrency.get(key);
    if (!b) {
      b = { orderAmount: new Prisma.Decimal(0), invoicedAmount: new Prisma.Decimal(0), paidAmount: new Prisma.Decimal(0) };
      totalsByCurrency.set(key, b);
    }
    return b;
  };
  for (const r of results) {
    const ob = bucketOf(r.currency);
    ob.orderAmount = ob.orderAmount.plus(dec(r.orderAmount));
    for (const g of r.invoicedByCurrency) {
      const b = bucketOf(g.currency);
      b.invoicedAmount = b.invoicedAmount.plus(dec(g.amount));
    }
    for (const g of r.paidByCurrency) {
      const b = bucketOf(g.currency);
      b.paidAmount = b.paidAmount.plus(dec(g.amount));
    }
  }
  const totalByCurrency: CustomerCurrencyTotals[] = [...totalsByCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, b]) => ({
      currency,
      orderAmount: d2n(b.orderAmount),
      invoicedAmount: d2n(b.invoicedAmount),
      paidAmount: d2n(b.paidAmount),
    }));
  // 三个标量只在**客户下币种唯一**（或全空）时有值；跨币种 → null（前端改看 totalByCurrency）
  const crossCurrency = totalByCurrency.length > 1;
  const soleTotals = crossCurrency ? null : (totalByCurrency[0] ?? null);

  const summary: CustomerReconciliationSummary = {
    customerRelationId,
    totalOrders: results.length,
    discrepancyOrders: results.filter(r => r.discrepancies.length > 0).length,
    totalOrderAmount: crossCurrency ? null : (soleTotals?.orderAmount ?? 0),
    totalInvoicedAmount: crossCurrency ? null : (soleTotals?.invoicedAmount ?? 0),
    totalPaidAmount: crossCurrency ? null : (soleTotals?.paidAmount ?? 0),
    totalByCurrency,
    settledCnyTotal: round4n(results.reduce((s, r) => s + r.settledCny, 0)),
    refundedCnyTotal: round4n(results.reduce((s, r) => s + r.refundedCny, 0)),
    criticalCount: results.reduce((s, r) => s + r.discrepancies.filter(d => d.severity === 'critical').length, 0),
    warningCount: results.reduce((s, r) => s + r.discrepancies.filter(d => d.severity === 'warning').length, 0),
    infoCount: results.reduce((s, r) => s + r.discrepancies.filter(d => d.severity === 'info').length, 0),
    fxGainLossTotal: [...fxByCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
  return { summary, orders: results };
}

export interface DiscrepancyListItem extends ReconciliationDiscrepancy {
  orderId: string;
  orderCode: string | null;
  poNumber: string | null;
  customerName: string | null;
  customerRelationId: string | null;
  currency: string | null;
  orderAmount: number;
}

/**
 * 全量差异清单：扫全部未删订单逐单勾稽，拍平差异按 severity 排序，内存分页。
 * （对账工作台口径；订单量大时后续可加快照缓存——POST /refresh 即为重算入口。）
 *
 * P2-7：fx 差异（汇率链三段）一并拍平，type=fx_order_to_invoice / fx_invoice_to_payment /
 * fx_payment_to_settlement；type 筛选支持精确匹配，或 type=fx 聚合匹配全部汇率链差异。
 */
export async function listAllDiscrepancies(
  prisma: PrismaClient,
  params: { severity?: DiscrepancySeverity; type?: string; customerRelationId?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: DiscrepancyListItem[]; total: number; page: number; pageSize: number }> {
  const db = prisma as any;
  const where: any = { deletedAt: null };
  if (params.customerRelationId) where.customerRelationId = params.customerRelationId;
  const orders: any[] = await db.order.findMany({ where, select: { id: true } });
  const matchType = (t: string) => {
    if (!params.type) return true;
    if (params.type === 'fx') return t.startsWith('fx_');
    return t === params.type;
  };
  const flat: DiscrepancyListItem[] = [];
  for (const o of orders) {
    const r = await reconcileOrder(prisma, o.id);
    if (!r) continue;
    const orderCtx = {
      orderId: r.orderId,
      orderCode: r.orderCode,
      poNumber: r.poNumber,
      customerName: r.customerName,
      customerRelationId: r.customerRelationId,
      currency: r.currency,
      orderAmount: r.orderAmount,
    };
    for (const d of r.discrepancies) {
      if (params.severity && d.severity !== params.severity) continue;
      if (!matchType(d.type)) continue;
      flat.push({ ...d, ...orderCtx });
    }
    // P2-7 汇率链差异拍平（FxDiscrepancy → 清单行；expected/actual 取期望/实际汇率）
    for (const fx of r.fxDiscrepancies) {
      if (params.severity && fx.severity !== params.severity) continue;
      const flatType = `fx_${fx.type}` as ReconciliationDiscrepancy['type'];
      if (!matchType(flatType)) continue;
      flat.push({
        type: flatType,
        field: 'exchangeRate',
        expected: fx.expectedRate != null ? String(fx.expectedRate) : '(缺上游汇率)',
        actual: fx.actualRate != null ? String(fx.actualRate) : '(缺单据汇率)',
        severity: fx.severity,
        message: fx.message,
        ...orderCtx,
      });
    }
  }
  const sorted = sortDiscrepancies(flat);
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(Math.max(1, params.pageSize ?? 50), 200);
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    page,
    pageSize,
  };
}
