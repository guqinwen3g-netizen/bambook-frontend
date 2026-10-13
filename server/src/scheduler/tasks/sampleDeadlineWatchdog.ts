import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 P0 回补 — 调度任务：船样 / 匹头样确认追踪预警（PRD 5.2）
 *
 * 每日 11:00 后执行一次（日去重）。扫描在手订单（排除已完结/已出运状态，
 * clientDate 可解析者）：
 *
 *   1. 船样（sampleConfirmedDate 为空）：
 *      today >= Exmill - 14 天 → warning；today > Exmill → 升 critical。
 *      dedupKey：sample_deadline:${orderId}:shipment:${clientDate}:${tier}
 *   2. 匹头样（仅当 fabricSampleSentDate 非空且 fabricSampleConfirmedDate 为空
 *      ——流程已启动未确认，不对无匹头样要求的订单误报）：
 *      today >= Exmill - 7 天 → warning；today > Exmill → 升 critical。
 *      dedupKey：sample_deadline:${orderId}:fabric:${clientDate}:${tier}
 *
 * 一律经 riskService.raiseAlert（type 'sample_deadline'，relatedType 'Order'），
 * 幂等语义由 RiskAlert.dedupKey @unique 承担（tier 升级会产生新键，形成升级轨迹）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 船样预警窗口：Exmill 前 14 天 */
const SHIPMENT_SAMPLE_WINDOW_DAYS = 14;
/** 匹头样预警窗口：Exmill 前 7 天 */
const FABRIC_SAMPLE_WINDOW_DAYS = 7;

/** 已完结 / 已出运 / 已开票收款状态不再追踪样品确认 */
const EXCLUDED_STATUSES = ['Cancelled', 'Closed', 'Shipped', 'Invoiced', 'PartiallyPaid', 'Paid'];

/** 解析 YYYY-MM-DD 为本地零点毫秒；非法返回 null（与 riskService 同口径） */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 扫描入口（watchdog 与测试直驱共用）：返回本次新产生的预警数。
 */
export async function scanSampleDeadlines(prisma: PrismaClient, today: Date = businessNowDate()): Promise<{ alerted: number }> {
  const db = prisma as any;
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const risk = createRiskService(prisma);

  const orders = await db.order.findMany({
    where: { deletedAt: null, status: { notIn: EXCLUDED_STATUSES } },
  });

  let alerted = 0;
  for (const order of orders) {
    const clientMs = parseDate(order.clientDate);
    if (clientMs === null) continue;

    const daysLeft = Math.floor((clientMs - todayMs) / DAY_MS);
    const tier: AlertLevel = todayMs > clientMs ? 'critical' : 'warning';
    const label = order.poNumber ?? order.id;
    const deadlineNote = daysLeft >= 0 ? `距 Exmill 仅剩 ${daysLeft} 天` : `已超 Exmill ${-daysLeft} 天`;

    // ─── 船样：未确认且进入 14 天窗口 ───
    if (!order.sampleConfirmedDate && todayMs >= clientMs - SHIPMENT_SAMPLE_WINDOW_DAYS * DAY_MS) {
      const { created } = await risk.raiseAlert({
        type: 'sample_deadline',
        level: tier,
        title: `订单 ${label} 船样未确认，${deadlineNote}`,
        content: `订单 ${label}（客户 ${order.customer}，产品 ${order.product}）船样尚未确认（寄出日 ${order.sampleSentDate ?? '未寄出'}），出厂交期 Exmill=${order.clientDate}，${deadlineNote}，请立即跟进客户确认。`,
        relatedType: 'Order',
        relatedId: order.id,
        dedupKey: `sample_deadline:${order.id}:shipment:${order.clientDate}:${tier}`,
      });
      if (created) alerted += 1;
    }

    // ─── 匹头样：流程已启动（已寄出）但未确认，且进入 7 天窗口 ───
    if (order.fabricSampleSentDate && !order.fabricSampleConfirmedDate && todayMs >= clientMs - FABRIC_SAMPLE_WINDOW_DAYS * DAY_MS) {
      const { created } = await risk.raiseAlert({
        type: 'sample_deadline',
        level: tier,
        title: `订单 ${label} 匹头样未确认，${deadlineNote}`,
        content: `订单 ${label}（客户 ${order.customer}，产品 ${order.product}）匹头样已于 ${order.fabricSampleSentDate} 寄出但未确认，出厂交期 Exmill=${order.clientDate}，${deadlineNote}，请立即跟进客户确认。`,
        relatedType: 'Order',
        relatedId: order.id,
        dedupKey: `sample_deadline:${order.id}:fabric:${order.clientDate}:${tier}`,
      });
      if (created) alerted += 1;
    }
  }

  if (alerted > 0) {
    logger.info('[SampleDeadlineWatchdog] scan', { alerted });
  }
  return { alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createSampleDeadlineWatchdogTask(): ScheduledTask {
  return {
    id: 'sample_deadline_watchdog',
    shouldRun: (now: Date) => {
      // 每日 11:00 后执行一次
      const dayKey = dayKeyOf(now);
      if (now.getHours() >= 11 && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanSampleDeadlines(prisma);
      } catch (e: any) {
        logger.error('[SampleDeadlineWatchdog] failed', { error: e?.message });
      }
    },
  };
}
