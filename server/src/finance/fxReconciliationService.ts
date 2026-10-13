/**
 * fxReconciliationService.ts — W-B 波次 P2-7 多币种应收应付对账（汇率链 + 锁汇优先）
 *
 * 背景：跨域契约表断层②已拍板「币种统一 Order.currency」（docs/README.md W-0 节），
 * 但多币种场景仍需汇率折算口径显式化。本服务是汇率链计算的**唯一真源**，
 * reconciliationService（对账引擎）与 reportService（FxGainLossReport）统一走这里，
 * 消除"各报表自算汇率损益"的口径分裂。
 *
 * 三段汇率链（单据汇率快照两两比对）：
 *   A 订单→开票：Invoice.exchangeRate（开票日快照） vs 期望汇率。
 *     Order 无汇率快照字段（schema 真源），订单侧基准 = 市场汇率档案
 *     （ExchangeRate effectiveDate ≤ issueDate 最近一条；无则回退最新一条）。
 *   B 开票→收付：PaymentVoucher.exchangeRate（收付日快照） vs Invoice.exchangeRate。
 *     本段差异 × 核销额 = 已实现汇兑损益（与 FxGainLossReport 同口径）。
 *   C 收付→结汇：FxSettlement.fxRate（结汇日实际） vs PaymentVoucher.exchangeRate。
 *     本段差异 × 结汇额 = 结汇环节已实现汇兑损益。
 *
 * 锁汇优先规则：
 *   - FxRateLock 模型无 status/amount 字段（schema 真源）：
 *     「Active」= deletedAt == null；「覆盖」= 按 (orderId, currency) 整单覆盖。
 *   - 存在 active 锁时，期望汇率取**锁定汇率**而非市场汇率；
 *     单据快照与锁定汇率的差异属锁汇设计内行为 → severity 记 info。
 *
 * 损益符号口径（computeFxGainLoss，全系统唯一符号真源）：
 *   Receivable：(toRate − fromRate) × foreignAmount（下游汇率高于上游 = 收益）
 *   Payable：   (fromRate − toRate) × foreignAmount（付汇汇率低于开票 = 收益）
 *
 * 差异分级：
 *   critical — 外币单据缺汇率快照（无法折算，数据断层）
 *   warning  — 无锁汇时偏差超阈值（A 段 >2% 疑录入错误；B/C 段 >5% 大幅波动）
 *   info     — 锁汇覆盖（设计内）/ 阈值内偏差 / 无市场档案可比对；偏差 ≈0 不记录
 *
 * 纯只读：不写库、不触发状态重算；金额 round4 / 汇率 round8 避免 IEEE 754 漂移。
 */
import { PrismaClient } from '@prisma/client';
import type { DiscrepancySeverity } from './reconciliationService';

export type FxChainSegmentType = 'order_to_invoice' | 'invoice_to_payment' | 'payment_to_settlement';
export type FxRateSource = 'locked' | 'market' | 'upstream' | 'missing';
export type FxDocumentKind = 'invoice' | 'voucher' | 'settlement';

export interface FxDiscrepancy {
  type: FxChainSegmentType;
  fromCurrency: string;          // 外币币种
  toCurrency: string;            // 本位币（CNY）
  expectedRate: number | null;   // 期望汇率（锁定 / 市场 / 上游快照）
  actualRate: number | null;     // 单据汇率快照
  variance: number | null;       // actualRate − expectedRate
  variancePct: number | null;    // variance / expectedRate
  severity: DiscrepancySeverity;
  message: string;
  locked: boolean;               // 是否锁汇覆盖（锁定期差异属设计内）
  documentKind: FxDocumentKind;
  documentId: string;
  documentNumber: string;
  foreignAmount: number;         // 该段涉及外币金额（发票额 / 核销额 / 结汇额）
  gainLossCny: number | null;    // 该段已实现汇兑损益（B/C 段；A 段恒 null——未实现）
}

export interface FxChainSegment {
  stage: FxChainSegmentType;
  documentKind: FxDocumentKind;
  documentId: string;
  documentNumber: string;
  currency: string;
  foreignAmount: number;
  documentRate: number | null;   // 单据汇率快照
  expectedRate: number | null;   // 期望汇率
  rateSource: FxRateSource;      // 期望汇率来源
  variance: number | null;
  variancePct: number | null;
  gainLossCny: number | null;
  locked: boolean;
}

export interface FxLockInfo {
  id: string;
  currency: string;
  rate: number;
}

export interface OrderFxReconciliation {
  orderId: string;
  baseCurrency: string;
  locks: FxLockInfo[];           // 该订单全部 active 锁（按币种）
  segments: FxChainSegment[];    // 三段对照行（前端汇率链对照表直接渲染）
  fxDiscrepancies: FxDiscrepancy[]; // 显著差异（缺快照 / 超阈值 / 锁汇偏移）
  realizedGainLossCny: number;   // 已实现汇兑损益合计（B+C 段，CNY）
  invoicedByCurrency: Array<{    // 外币应收分组（客户维度锁汇覆盖率汇总真源）
    currency: string;
    amount: number;              // 发票外币总额
    lockedAmount: number;        // 其中锁汇覆盖金额
  }>;
}

const BASE_CURRENCY = 'CNY';
const RATE_EPS = 1e-6;
const SEGMENT_A_WARNING_PCT = 0.02;  // 开票快照 vs 市场/锁定：应贴近，>2% 疑录入错误
const SEGMENT_BC_WARNING_PCT = 0.05; // 跨期漂移：>5% 大幅波动需关注

const FX_SEVERITY_RANK: Record<DiscrepancySeverity, number> = { critical: 0, warning: 1, info: 2 };

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(typeof (v as any)?.toString === 'function' ? (v as any).toString() : v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 汇兑损益符号唯一真源。
 * Receivable：下游汇率高于上游 = 收益；Payable：下游汇率低于上游 = 收益。
 */
export function computeFxGainLoss(params: {
  side: string; // 'Receivable' | 'Payable'
  foreignAmount: number;
  fromRate: number; // 上游汇率（开票日 / 收付日）
  toRate: number;   // 下游汇率（收付日 / 结汇日）
}): number {
  const diff = params.side === 'Payable'
    ? params.fromRate - params.toRate
    : params.toRate - params.fromRate;
  return round4(params.foreignAmount * diff);
}

/** active 锁 = deletedAt == null（FxRateLock 无 status 字段）；按 (orderId, currency) 整单覆盖。 */
export async function findActiveFxLock(
  prisma: PrismaClient,
  orderId: string,
  currency: string,
): Promise<FxLockInfo | null> {
  const db = prisma as any;
  const row = await db.fxRateLock.findFirst({ where: { orderId, currency, deletedAt: null } });
  if (!row) return null;
  const rate = num(row.rate);
  return rate == null ? null : { id: row.id, currency: row.currency, rate };
}

/** 市场汇率：effectiveDate ≤ onDate 最近一条；无则回退该币种最新一条；再无 → null。 */
async function marketRateOn(
  db: any,
  currency: string,
  onDate: string | null,
  cache: Map<string, number | null>,
): Promise<number | null> {
  const key = `${currency}@${onDate ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  let row: any = null;
  if (onDate) {
    row = await db.exchangeRate.findFirst({
      where: { currency, effectiveDate: { lte: onDate } },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
  }
  if (!row) {
    row = await db.exchangeRate.findFirst({
      where: { currency },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
  }
  const rate = row ? num(row.rate) : null;
  cache.set(key, rate);
  return rate;
}

/**
 * 单订单汇率链对账。订单不存在/已软删返回 null（与 reconcileOrder 同契约）。
 * 发票关联路径与 reconciliationService 一致：IOA(orderId) ∪ Invoice.orderId 直挂，
 * Receivable 且未作废。
 */
export async function reconcileOrderFx(
  prisma: PrismaClient,
  orderId: string,
): Promise<OrderFxReconciliation | null> {
  const db = prisma as any;

  const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
  if (!order) return null;

  // ── 发票集合（同主引擎关联路径） ──
  const ioaRows: any[] = await db.invoiceOrderAllocation.findMany({ where: { orderId, deletedAt: null } });
  const ioaInvoiceIds = [...new Set(ioaRows.map((a: any) => a.invoiceId))] as string[];
  const directInvoices: any[] = await db.invoice.findMany({
    where: { orderId, type: 'Receivable', deletedAt: null },
  });
  const allInvoiceIds = [...new Set([...ioaInvoiceIds, ...directInvoices.map((i: any) => i.id)])] as string[];
  const invoices: any[] = allInvoiceIds.length > 0
    ? (await db.invoice.findMany({ where: { id: { in: allInvoiceIds }, deletedAt: null } }) as any[])
        .filter((i: any) => i.type === 'Receivable' && i.status !== 'Cancelled')
    : [];
  const invoiceById = new Map<string, any>(invoices.map((i: any) => [i.id, i]));

  // ── 锁汇（active；按币种整单覆盖） ──
  const lockRows: any[] = await db.fxRateLock.findMany({ where: { orderId, deletedAt: null } });
  const locks: FxLockInfo[] = [];
  const lockByCurrency = new Map<string, FxLockInfo>();
  for (const l of lockRows ?? []) {
    const rate = num(l.rate);
    if (rate == null) continue;
    const info: FxLockInfo = { id: l.id, currency: l.currency, rate };
    locks.push(info);
    lockByCurrency.set(l.currency, info);
  }

  // ── 核销 → 凭证 ──
  const invoiceIds = invoices.map((i: any) => i.id);
  const allocations: any[] = invoiceIds.length > 0
    ? await db.invoiceAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } })
    : [];
  const voucherIds = [...new Set(allocations.map((a: any) => a.voucherId))] as string[];
  const vouchers: any[] = voucherIds.length > 0
    ? await db.paymentVoucher.findMany({ where: { id: { in: voucherIds } } })
    : [];
  const voucherById = new Map<string, any>(vouchers.map((v: any) => [v.id, v]));

  // ── 结汇水单（orderId 冗余投影 ∪ 凭证关联，按 id 去重） ──
  const [settlementsByOrder, settlementsByVoucher]: [any[], any[]] = await Promise.all([
    db.fxSettlement.findMany({ where: { orderId, deletedAt: null } }),
    voucherIds.length > 0
      ? db.fxSettlement.findMany({ where: { voucherId: { in: voucherIds }, deletedAt: null } })
      : Promise.resolve([]),
  ]);
  const settlementById = new Map<string, any>();
  for (const s of [...settlementsByOrder, ...settlementsByVoucher]) settlementById.set(s.id, s);
  // 结汇的凭证可能未核销本订单发票（voucher 不在 voucherIds 内），补载
  const missingVoucherIds = [...settlementById.values()]
    .map((s: any) => s.voucherId)
    .filter((id: string) => !voucherById.has(id));
  if (missingVoucherIds.length > 0) {
    const extra: any[] = await db.paymentVoucher.findMany({ where: { id: { in: [...new Set(missingVoucherIds)] } } });
    for (const v of extra) voucherById.set(v.id, v);
  }

  const segments: FxChainSegment[] = [];
  const discrepancies: FxDiscrepancy[] = [];
  const rateCache = new Map<string, number | null>();
  let realized = 0;

  const record = (
    seg: FxChainSegment,
    disc: FxDiscrepancy | null,
  ) => {
    segments.push(seg);
    if (disc) discrepancies.push(disc);
  };

  const mkVariance = (actual: number | null, expected: number | null) => {
    if (actual == null || expected == null || expected === 0) return { variance: null, variancePct: null };
    const variance = round8(actual - expected);
    return { variance, variancePct: round8(variance / expected) };
  };

  // ── A 段：订单→开票 ──
  for (const inv of invoices) {
    const currency: string | null = inv.currency ?? null;
    if (!currency || currency === BASE_CURRENCY) continue;
    const lock = lockByCurrency.get(currency) ?? null;
    const actual = num(inv.exchangeRate);
    const expected = lock ? lock.rate : await marketRateOn(db, currency, inv.issueDate ?? null, rateCache);
    const { variance, variancePct } = mkVariance(actual, expected);
    const amount = num(inv.amount) ?? 0;
    const seg: FxChainSegment = {
      stage: 'order_to_invoice',
      documentKind: 'invoice',
      documentId: inv.id,
      documentNumber: inv.invoiceNumber,
      currency,
      foreignAmount: amount,
      documentRate: actual,
      expectedRate: expected,
      rateSource: lock ? 'locked' : expected != null ? 'market' : 'missing',
      variance,
      variancePct,
      gainLossCny: null, // A 段为未实现估值偏差，不计损益
      locked: lock != null,
    };

    let disc: FxDiscrepancy | null = null;
    const base = {
      type: 'order_to_invoice' as const,
      fromCurrency: currency,
      toCurrency: inv.baseCurrency ?? BASE_CURRENCY,
      expectedRate: expected,
      actualRate: actual,
      variance,
      variancePct,
      locked: lock != null,
      documentKind: 'invoice' as const,
      documentId: inv.id,
      documentNumber: inv.invoiceNumber,
      foreignAmount: amount,
      gainLossCny: null,
    };
    if (actual == null) {
      disc = {
        ...base,
        severity: 'critical',
        message: `外币发票 ${inv.invoiceNumber} 缺开票日汇率快照，本位币折算无真源`,
      };
    } else if (expected == null) {
      disc = {
        ...base,
        severity: 'info',
        message: `币种 ${currency} 无市场汇率档案，开票汇率 ${actual} 无法比对`,
      };
    } else if (variance != null && Math.abs(variance) > RATE_EPS) {
      if (lock) {
        disc = {
          ...base,
          severity: 'info',
          message: `锁汇 ${lock.rate} 覆盖：开票汇率 ${actual} 与锁定汇率差 ${variance}（锁汇设计内，应收按锁定汇率折算）`,
        };
      } else if (variancePct != null && Math.abs(variancePct) > SEGMENT_A_WARNING_PCT) {
        disc = {
          ...base,
          severity: 'warning',
          message: `开票汇率 ${actual} 偏离市场汇率 ${expected}（${(variancePct * 100).toFixed(2)}%），疑录入错误`,
        };
      } else {
        disc = {
          ...base,
          severity: 'info',
          message: `开票汇率 ${actual} 与市场汇率 ${expected} 微差 ${variance}`,
        };
      }
    }
    record(seg, disc);
  }

  // ── B 段：开票→收付（核销维度，损益 = 核销额 × 汇率差） ──
  for (const alloc of allocations) {
    const inv = invoiceById.get(alloc.invoiceId);
    const voc = voucherById.get(alloc.voucherId);
    if (!inv || !voc) continue;
    const currency: string | null = inv.currency ?? null;
    if (!currency || currency === BASE_CURRENCY) continue;
    if (voc.currency !== currency) continue; // 跨币种核销不属本链（订单层由 currency_mismatch 覆盖）
    const fromRate = num(inv.exchangeRate);
    const toRate = num(voc.exchangeRate);
    const lock = lockByCurrency.get(currency) ?? null;
    const applied = num(alloc.appliedAmount) ?? 0;
    const { variance, variancePct } = mkVariance(toRate, fromRate);
    const gainLoss = fromRate != null && toRate != null
      ? computeFxGainLoss({ side: inv.type, foreignAmount: applied, fromRate, toRate })
      : null;
    if (gainLoss != null) realized = round4(realized + gainLoss);
    const seg: FxChainSegment = {
      stage: 'invoice_to_payment',
      documentKind: 'voucher',
      documentId: voc.id,
      documentNumber: voc.voucherNumber,
      currency,
      foreignAmount: applied,
      documentRate: toRate,
      expectedRate: fromRate,
      rateSource: fromRate != null ? 'upstream' : 'missing',
      variance,
      variancePct,
      gainLossCny: gainLoss,
      locked: lock != null,
    };

    let disc: FxDiscrepancy | null = null;
    const base = {
      type: 'invoice_to_payment' as const,
      fromCurrency: currency,
      toCurrency: inv.baseCurrency ?? BASE_CURRENCY,
      expectedRate: fromRate,
      actualRate: toRate,
      variance,
      variancePct,
      locked: lock != null,
      documentKind: 'voucher' as const,
      documentId: voc.id,
      documentNumber: voc.voucherNumber,
      foreignAmount: applied,
      gainLossCny: gainLoss,
    };
    if (toRate == null) {
      disc = {
        ...base,
        severity: 'critical',
        message: `收款凭证 ${voc.voucherNumber} 缺收付日汇率快照，汇兑损益无法确认`,
      };
    } else if (fromRate != null && variance != null && Math.abs(variance) > RATE_EPS) {
      // fromRate 缺失由 A 段 critical 覆盖，此处不重复记
      const glText = gainLoss != null ? `，汇兑${gainLoss >= 0 ? '收益' : '损失'} ${Math.abs(gainLoss)} CNY` : '';
      if (lock) {
        disc = {
          ...base,
          severity: 'info',
          message: `锁汇 ${lock.rate} 覆盖：收付汇率 ${toRate} 与开票汇率 ${fromRate} 差 ${variance}${glText}（锁汇设计内）`,
        };
      } else if (variancePct != null && Math.abs(variancePct) > SEGMENT_BC_WARNING_PCT) {
        disc = {
          ...base,
          severity: 'warning',
          message: `收付汇率 ${toRate} 与开票汇率 ${fromRate} 漂移 ${(variancePct! * 100).toFixed(2)}%${glText}`,
        };
      } else {
        disc = {
          ...base,
          severity: 'info',
          message: `收付汇率 ${toRate} 与开票汇率 ${fromRate} 差 ${variance}${glText}`,
        };
      }
    }
    record(seg, disc);
  }

  // ── C 段：收付→结汇（水单维度，损益 = 结汇额 × 汇率差） ──
  for (const st of settlementById.values()) {
    const voc = voucherById.get(st.voucherId);
    if (!voc) continue;
    const currency: string | null = st.currency ?? voc.currency ?? null;
    if (!currency || currency === BASE_CURRENCY) continue;
    const fromRate = num(voc.exchangeRate);
    const toRate = num(st.fxRate);
    const lock = lockByCurrency.get(currency) ?? null;
    const foreign = num(st.foreignAmount) ?? 0;
    const { variance, variancePct } = mkVariance(toRate, fromRate);
    const gainLoss = fromRate != null && toRate != null
      ? computeFxGainLoss({ side: 'Receivable', foreignAmount: foreign, fromRate, toRate })
      : null;
    if (gainLoss != null) realized = round4(realized + gainLoss);
    const seg: FxChainSegment = {
      stage: 'payment_to_settlement',
      documentKind: 'settlement',
      documentId: st.id,
      documentNumber: st.settlementNumber,
      currency,
      foreignAmount: foreign,
      documentRate: toRate,
      expectedRate: fromRate,
      rateSource: fromRate != null ? 'upstream' : 'missing',
      variance,
      variancePct,
      gainLossCny: gainLoss,
      locked: lock != null,
    };

    let disc: FxDiscrepancy | null = null;
    const base = {
      type: 'payment_to_settlement' as const,
      fromCurrency: currency,
      toCurrency: voc.baseCurrency ?? BASE_CURRENCY,
      expectedRate: fromRate,
      actualRate: toRate,
      variance,
      variancePct,
      locked: lock != null,
      documentKind: 'settlement' as const,
      documentId: st.id,
      documentNumber: st.settlementNumber,
      foreignAmount: foreign,
      gainLossCny: gainLoss,
    };
    if (fromRate == null) {
      disc = {
        ...base,
        severity: 'critical',
        message: `结汇水单 ${st.settlementNumber} 的上游凭证缺收付日汇率快照，结汇损益无法确认`,
      };
    } else if (variance != null && Math.abs(variance) > RATE_EPS) {
      const glText = gainLoss != null ? `，汇兑${gainLoss >= 0 ? '收益' : '损失'} ${Math.abs(gainLoss)} CNY` : '';
      if (lock) {
        disc = {
          ...base,
          severity: 'info',
          message: `锁汇 ${lock.rate} 覆盖：结汇汇率 ${toRate} 与收付汇率 ${fromRate} 差 ${variance}${glText}（锁汇设计内）`,
        };
      } else if (variancePct != null && Math.abs(variancePct) > SEGMENT_BC_WARNING_PCT) {
        disc = {
          ...base,
          severity: 'warning',
          message: `结汇汇率 ${toRate} 与收付汇率 ${fromRate} 漂移 ${(variancePct! * 100).toFixed(2)}%${glText}`,
        };
      } else {
        disc = {
          ...base,
          severity: 'info',
          message: `结汇汇率 ${toRate} 与收付汇率 ${fromRate} 差 ${variance}${glText}`,
        };
      }
    }
    record(seg, disc);
  }

  // ── 外币应收分组（锁汇覆盖率真源） ──
  const byCurrency = new Map<string, { amount: number; lockedAmount: number }>();
  for (const inv of invoices) {
    const currency: string | null = inv.currency ?? null;
    if (!currency || currency === BASE_CURRENCY) continue;
    const amount = num(inv.amount) ?? 0;
    const b = byCurrency.get(currency) ?? { amount: 0, lockedAmount: 0 };
    b.amount = round4(b.amount + amount);
    if (lockByCurrency.has(currency)) b.lockedAmount = round4(b.lockedAmount + amount);
    byCurrency.set(currency, b);
  }

  const STAGE_RANK: Record<FxChainSegmentType, number> = { order_to_invoice: 0, invoice_to_payment: 1, payment_to_settlement: 2 };
  segments.sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || a.documentNumber.localeCompare(b.documentNumber));
  discrepancies.sort((a, b) => FX_SEVERITY_RANK[a.severity] - FX_SEVERITY_RANK[b.severity]);

  return {
    orderId,
    baseCurrency: BASE_CURRENCY,
    locks,
    segments,
    fxDiscrepancies: discrepancies,
    realizedGainLossCny: realized,
    invoicedByCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, b]) => ({ currency, amount: b.amount, lockedAmount: b.lockedAmount })),
  };
}
