import { businessNowDate } from '../shared/businessClock';
import type { TokenPayload } from '../auth/service';
/**
 * 阶段 E / E2 — 经营简报组装服务（日报 / 周报单一权威源）
 *
 * 职责：组装经营简报文本与结构化 metadata，供 dailyBriefing / weeklyBriefing
 * 两个调度任务复用；不写库、不推通知（推送由任务层负责），可独立单测。
 *
 * 口径：
 *   - 昨日动态：近 24h 订单变更/确认、发货、开票、收款计数（沿用 Phase 0 dailyBriefing 口径）
 *   - 在手订单敞口：status ∉ Delivered/Cancelled，按销售币种（salesCurrency ?? currency）
 *     合计承揽额（★ S4 任务3：走唯一真源 orderAmountOf，不再内联 contractAmount ?? quoteAmount）
 *   - 应收逾期：复用 B2 getAgingReport（Receivable），逾期 = d1_30+d31_60+d61_90+d90plus
 *   - 毛利：复用 C1 getBusinessCockpit（dueDate 区间过滤）；日报取本月至今，周报取上周区间
 *   - 环比（周报）：上周 vs 上上周销售额合计（同币种匹配，无上周基数则不报环比）
 *
 * 风险分级（level）：
 *   - warning：存在长账龄应收逾期（d61_90 + d90plus > 0），或区间内存在负毛利订单，
 *     或（周报）销售额环比下滑 > 30%
 *   - info：其余
 *
 * 日期惯例：YYYY-MM-DD 本地日历日（与 E1 预警任务一致，避免 UTC 漂移）。
 * BigInt 时间戳字段（updatedAt/createdAt）用 number 毫秒比较。
 */

import { PrismaClient } from '@prisma/client';
import { getBusinessCockpit, type OrderMarginTotal } from '../dashboard/dashboardService';
import { getAgingReport, type AgingRow } from '../finance/reportService';
// ★ S4 任务3：订单金额口径收口到唯一真源（原写法 `contractAmount ?? quoteAmount` 不在真源次序里）
import { orderAmountOf } from '../shared/orderAmount';

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export type BriefingLevel = 'info' | 'warning';

export interface BriefingContent {
  title: string;
  body: string;
  level: BriefingLevel;
  metadata: Record<string, any>;
}

// ────────────────────────────────────────────────────────────────
// 日期 / 金额工具
// ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地零点毫秒 */
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本地零点毫秒 → YYYY-MM-DD */
export function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 上周一零点毫秒（本地）。getDay: 0=周日 … 1=周一 … 6=周六 */
export function lastMondayMs(now: Date): number {
  const todayMs = localMidnight(now);
  const dow = now.getDay();
  const daysSinceMonday = (dow + 6) % 7; // 周一=0 … 周日=6
  return todayMs - (daysSinceMonday + 7) * DAY_MS;
}

/** 金额格式化：千分位 + 至多两位小数（round2 防止浮点尾巴） */
export function fmtMoney(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 多币种合计 → "USD 12,345 / CNY 67,890"；空 → '—' */
function fmtCurrencyTotals(totals: Array<{ currency: string; amount: number }>): string {
  const parts = totals
    .filter(t => t.amount !== 0)
    .sort((a, b) => b.amount - a.amount)
    .map(t => `${t.currency} ${fmtMoney(t.amount)}`);
  return parts.length > 0 ? parts.join(' / ') : '—';
}

function marginTotalsToAmounts(totals: OrderMarginTotal[]): Array<{ currency: string; amount: number }> {
  // margin null = sensitive 遮罩口径（驾驶舱出口遮罩后的数据不进简报正文）
  const hasMargin = (t: OrderMarginTotal): t is OrderMarginTotal & { margin: number } => t.margin != null;
  return totals.filter(hasMargin).map(t => ({ currency: t.currency, amount: t.margin }));
}

// ────────────────────────────────────────────────────────────────
// 日报
// ────────────────────────────────────────────────────────────────

/**
 * 组装每日经营简报。
 * @param now 当前时间（测试可注入）；近 24h = now - 24h
 */
export async function buildDailyBriefing(
  prisma: PrismaClient,
  now: Date = businessNowDate(),
  actor?: TokenPayload,
): Promise<BriefingContent> {
  const todayMs = localMidnight(now);
  const today = formatLocalDate(todayMs);
  const sinceMs = now.getTime() - DAY_MS;

  // ── 1. 昨日动态（近 24h 计数，沿用 Phase 0 口径） ──
  // 金额合计按币种 groupBy（混币裸加会把 EUR 当 USD 虚增，与 C1 多币种分行口径一致）
  const [
    newOrders,
    confirmedOrders,
    shipmentsDelivered,
    invoicesIssued,
    invoicesIssuedByCurrency,
    vouchersCreated,
    vouchersCreatedByCurrency,
    pendingConfirmations,
  ] = await Promise.all([
    prisma.order.count({ where: { updatedAt: { gte: sinceMs }, deletedAt: null } }),
    prisma.order.count({ where: { status: 'Confirmed', updatedAt: { gte: sinceMs }, deletedAt: null } }),
    prisma.shipment.count({ where: { status: 'Delivered', updatedAt: { gte: sinceMs }, deletedAt: null } }),
    prisma.invoice.count({ where: { status: 'Issued', updatedAt: { gte: sinceMs }, deletedAt: null } }),
    prisma.invoice.groupBy({
      by: ['currency'],
      where: { status: 'Issued', updatedAt: { gte: sinceMs }, deletedAt: null },
      _sum: { amount: true },
    }),
    prisma.paymentVoucher.count({ where: { createdAt: { gte: sinceMs }, deletedAt: null } }),
    prisma.paymentVoucher.groupBy({
      by: ['currency'],
      where: { createdAt: { gte: sinceMs }, deletedAt: null },
      _sum: { amount: true },
    }),
    prisma.order.count({ where: { status: 'Pending', deletedAt: null } }),
  ]);
  const toCurrencyTotals = (groups: Array<{ currency: string; _sum: { amount: unknown } }>) =>
    groups
      .map(g => ({ currency: g.currency, amount: Number(g._sum.amount ?? 0) || 0 }))
      .filter(t => t.amount !== 0);
  const invTotals = toCurrencyTotals(invoicesIssuedByCurrency);
  const vocTotals = toCurrencyTotals(vouchersCreatedByCurrency);

  // ── 2. 在手订单敞口（未交付/未取消，分币种；金额走唯一真源 orderAmountOf） ──
  const openOrders = await prisma.order.findMany({
    where: { deletedAt: null, status: { notIn: ['Delivered', 'Cancelled'] } },
    select: { contractAmount: true, totalNet: true, quoteAmount: true, currency: true, salesCurrency: true },
  });
  const openMap = new Map<string, number>();
  for (const o of openOrders) {
    const cur = o.salesCurrency ?? o.currency ?? 'USD';
    const amt = orderAmountOf(o);
    openMap.set(cur, (openMap.get(cur) ?? 0) + amt);
  }
  const openExposure = [...openMap.entries()].map(([currency, amount]) => ({ currency, amount }));

  // ── 3. 应收逾期快照（B2 账龄） ──
  const arAging = await getAgingReport(prisma, { actor, type: 'Receivable', asOf: today });
  const overdueOf = (r: AgingRow) => r.buckets.d1_30 + r.buckets.d31_60 + r.buckets.d61_90 + r.buckets.d90plus;
  const arOverdueMap = new Map<string, number>();
  let longAgingTotal = 0; // d61_90 + d90plus（跨币种简单加总仅用于分级判断，不进正文）
  for (const r of arAging.rows) {
    const od = overdueOf(r);
    if (od > 0) arOverdueMap.set(r.currency, (arOverdueMap.get(r.currency) ?? 0) + od);
    longAgingTotal += r.buckets.d61_90 + r.buckets.d90plus;
  }
  const arOverdue = [...arOverdueMap.entries()].map(([currency, amount]) => ({ currency, amount }));
  const topOverdueRow = arAging.rows
    .filter(r => overdueOf(r) > 0)
    .sort((a, b) => overdueOf(b) - overdueOf(a))[0] ?? null;

  // ── 4. 本月毛利（C1 口径：dueDate ∈ [月初, 今天]） ──
  const monthStart = formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  const cockpit = await getBusinessCockpit(prisma, { actor, from: monthStart, to: today });
  const marginTotals = cockpit.orderMargins.totals;
  const negativeMarginCount = cockpit.orderMargins.rows.filter(r => r.margin != null && r.margin < 0).length;

  // ── 5. 分级 ──
  const level: BriefingLevel = longAgingTotal > 0 || negativeMarginCount > 0 ? 'warning' : 'info';

  // ── 6. 正文组装 ──
  const lines: string[] = [
    `【昨日动态】订单变更 ${newOrders} 笔·确认 ${confirmedOrders} 笔；发货 ${shipmentsDelivered} 单；开票 ${invoicesIssued} 张${invTotals.length > 0 ? `（合计 ${fmtCurrencyTotals(invTotals)}）` : ''}；收款 ${vouchersCreated} 笔${vocTotals.length > 0 ? `（合计 ${fmtCurrencyTotals(vocTotals)}）` : ''}`,
    `【在手订单】${openOrders.length} 笔，敞口 ${fmtCurrencyTotals(openExposure)}`,
    `【应收逾期】${fmtCurrencyTotals(arOverdue)}${topOverdueRow ? `（最大逾期户：${topOverdueRow.customerName} ${topOverdueRow.currency} ${fmtMoney(overdueOf(topOverdueRow))}）` : ''}`,
  ];
  if (marginTotals.length > 0) {
    // margin null = sensitive 遮罩口径，不进简报正文
    const hasMargin = (t: OrderMarginTotal): t is OrderMarginTotal & { margin: number } => t.margin != null;
    const marginStr = marginTotals
      .filter(hasMargin)
      .map(t => `${t.currency} ${fmtMoney(t.margin)}${t.marginRate != null ? `（${fmtMoney(t.marginRate * 100)}%）` : ''}`)
      .join(' / ');
    lines.push(`【本月毛利】${marginStr}${negativeMarginCount > 0 ? `；亏损订单 ${negativeMarginCount} 笔` : ''}`);
  } else {
    lines.push('【本月毛利】暂无可计毛利订单（缺成本或跨币种）');
  }
  if (pendingConfirmations > 0) lines.push(`【待办】待确认订单 ${pendingConfirmations} 笔`);

  return {
    title: `每日经营摘要 ${today}`,
    body: lines.join('\n'),
    level,
    metadata: {
      date: today,
      stats: {
        newOrders, confirmedOrders, shipmentsDelivered,
        invoicesIssued, invoicesIssuedTotals: invTotals,
        vouchersCreated, vouchersCreatedTotals: vocTotals,
        openOrderCount: openOrders.length, openExposure,
        arOverdue, topOverdueCustomer: topOverdueRow?.customerName ?? null,
        longAgingTotal, negativeMarginCount,
        pendingConfirmations,
      },
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 周报
// ────────────────────────────────────────────────────────────────

/** 销售额环比下滑超过该比例 → warning */
const WOW_DROP_WARNING_RATIO = 0.3;

/**
 * 组装每周经营简报（上周一 ~ 上周日区间）。
 * @param now 当前时间（测试可注入）
 */
export async function buildWeeklyBriefing(
  prisma: PrismaClient,
  now: Date = businessNowDate(),
  actor?: TokenPayload,
): Promise<BriefingContent> {
  const weekStartMs = lastMondayMs(now);
  const weekEndMs = weekStartMs + 6 * DAY_MS;
  const from = formatLocalDate(weekStartMs);
  const to = formatLocalDate(weekEndMs);
  const prevFrom = formatLocalDate(weekStartMs - 7 * DAY_MS);
  const prevTo = formatLocalDate(weekStartMs - 1 * DAY_MS);

  const [week, prevWeek] = await Promise.all([
    getBusinessCockpit(prisma, { actor, from, to }),
    getBusinessCockpit(prisma, { actor, from: prevFrom, to: prevTo }),
  ]);

  // ── 1. 销售概览（按币种合计） + 环比 ──
  const sumBy = (rows: Array<{ currency: string; salesAmount: number }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + r.salesAmount);
    return m;
  };
  const weekSales = sumBy(week.salesLeaderboard);
  const prevSales = sumBy(prevWeek.salesLeaderboard);
  const weekOrderCount = week.salesLeaderboard.reduce((s, r) => s + r.orderCount, 0);

  const wowParts: string[] = [];
  let maxDropRatio = 0;
  for (const [cur, amt] of weekSales) {
    const prev = prevSales.get(cur) ?? 0;
    if (prev > 0) {
      const ratio = (amt - prev) / prev;
      if (ratio < 0) maxDropRatio = Math.max(maxDropRatio, -ratio);
      wowParts.push(`${cur} ${ratio >= 0 ? '+' : ''}${fmtMoney(ratio * 100)}%`);
    } else if (amt > 0) {
      wowParts.push(`${cur} 新增`);
    }
  }

  // ── 2. 排行 Top3 ──
  const topSales = week.salesLeaderboard.slice(0, 3)
    .map((r, i) => `${i + 1}. ${r.salesPerson} ${r.currency} ${fmtMoney(r.salesAmount)}（${r.orderCount} 单）`);
  const topCustomers = week.customerContribution.slice(0, 3)
    .map((r, i) => `${i + 1}. ${r.customer} ${r.currency} ${fmtMoney(r.salesAmount)}（占 ${fmtMoney(r.share * 100)}%）`);

  // ── 3. 毛利 ──
  const marginTotals = week.orderMargins.totals;
  const negativeMarginCount = week.orderMargins.rows.filter(r => r.margin != null && r.margin < 0).length;

  // ── 4. 应收/应付逾期快照 ──
  const arOverdue = week.arApAlerts.receivable.totals.map(t => ({ currency: t.currency, amount: t.overdue }));
  const apOverdue = week.arApAlerts.payable.totals.map(t => ({ currency: t.currency, amount: t.overdue }));
  const longAgingTotal = week.arApAlerts.receivable.rows
    .reduce((s, r) => s + r.buckets.d61_90 + r.buckets.d90plus, 0);

  // ── 5. 汇率损益 ──
  const fx = week.fxSummary;

  // ── 6. 分级 ──
  const level: BriefingLevel =
    longAgingTotal > 0 || negativeMarginCount > 0 || maxDropRatio > WOW_DROP_WARNING_RATIO
      ? 'warning' : 'info';

  // ── 7. 正文组装 ──
  const lines: string[] = [
    `【销售概览】区间订单 ${weekOrderCount} 笔，承揽 ${fmtCurrencyTotals([...weekSales.entries()].map(([currency, amount]) => ({ currency, amount })))}`,
    `【环比上周】${wowParts.length > 0 ? wowParts.join(' / ') : '无上上周可比基数'}`,
  ];
  if (topSales.length > 0) lines.push(`【销售排行】${topSales.join('；')}`);
  if (topCustomers.length > 0) lines.push(`【客户贡献】${topCustomers.join('；')}`);
  if (marginTotals.length > 0) {
    const marginStr = marginTotalsToAmounts(marginTotals)
      .map(t => `${t.currency} ${fmtMoney(t.amount)}`)
      .join(' / ');
    lines.push(`【区间毛利】${marginStr}${negativeMarginCount > 0 ? `；亏损订单 ${negativeMarginCount} 笔` : ''}`);
  } else {
    lines.push('【区间毛利】暂无可计毛利订单（缺成本或跨币种）');
  }
  lines.push(`【应收逾期】${fmtCurrencyTotals(arOverdue)}；【应付逾期】${fmtCurrencyTotals(apOverdue)}`);
  if (fx.rowCount > 0) {
    lines.push(`【汇率损益】${fx.baseCurrency} ${fmtMoney(fx.totalGainLoss)}（${fx.rowCount} 笔重估）`);
  }

  return {
    title: `每周经营报告 ${from} ~ ${to}`,
    body: lines.join('\n'),
    level,
    metadata: {
      from, to, prevFrom, prevTo,
      stats: {
        orderCount: weekOrderCount,
        sales: [...weekSales.entries()].map(([currency, amount]) => ({ currency, amount })),
        wow: wowParts,
        maxDropRatio,
        topSales: topSales.length,
        topCustomers: topCustomers.length,
        margins: marginTotalsToAmounts(marginTotals),
        negativeMarginCount,
        arOverdue, apOverdue, longAgingTotal,
        fxGainLoss: fx.totalGainLoss, fxRowCount: fx.rowCount,
      },
    },
  };
}
