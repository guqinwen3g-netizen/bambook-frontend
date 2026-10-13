import { businessNowDate } from '../../shared/businessClock';
/**
 * 调度任务：报价发出超期未回复跟进提醒（PRD 7.1「报价超 7 天未回复」）
 *
 * 每日 11:30 后运行一次（与其他 watchdog 错峰）。扫描 status=Sent 且
 * sentAt（首次发送时间，Draft→Sent 写入）已超过 7 天的报价单，分级提醒：
 *   - 7-13 天未回复 → warning
 *   - ≥14 天未回复 → critical（升级会产生新 dedup 键，形成升级轨迹）
 *
 * 幂等：notification metadata.stuckKey = quotation:no_reply:${quotationId}:${tier}:${today}
 * 同级别当天只发一条；被接受/拒绝/过期（状态离开 Sent）后自然停止。
 *
 * 通道：notificationService.broadcastNotification（系统内通知，PRD 7.1 默认渠道），
 * 与列表页「已发送 N 天 · 待客户回复」徽章共用 sentAt 口径。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 报价发出 ≥7 天未回复开始提醒 */
const FOLLOW_UP_DAYS = 7;
/** ≥14 天未回复升 critical */
const CRITICAL_DAYS = 14;
const BATCH_LIMIT = 50;

type Tier = 'warning' | 'critical';

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

/** 本地零点毫秒 → YYYY-MM-DD */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 扫描 + 通知主流程（导出供测试直接驱动）。
 * @returns 本次新发送的通知数
 */
export async function scanQuotationFollowUps(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<{ notified: number }> {
  const notificationService = createNotificationService(prisma);
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayStr = formatDate(todayMs);

  // sentAt 为 BigInt 毫秒；Prisma BigInt 比较用 BigInt 字面量
  const sentBefore = BigInt(todayMs - FOLLOW_UP_DAYS * DAY_MS);
  const quotations = await prisma.quotation.findMany({
    where: {
      status: 'Sent',
      deletedAt: null,
      sentAt: { not: null, lte: sentBefore },
    },
    select: {
      id: true,
      quotationNumber: true,
      customerName: true,
      totalAmount: true,
      currency: true,
      sentAt: true,
    },
    take: BATCH_LIMIT,
  });

  let notified = 0;
  for (const qt of quotations) {
    const sentMs = Number(qt.sentAt);
    if (!Number.isFinite(sentMs) || sentMs <= 0) continue;
    const days = Math.floor((todayMs - sentMs) / DAY_MS);
    if (days < FOLLOW_UP_DAYS) continue;
    const tier: Tier = days >= CRITICAL_DAYS ? 'critical' : 'warning';
    const stuckKey = `quotation:no_reply:${qt.id}:${tier}:${todayStr}`;

    const existing = await prisma.notification.findFirst({
      where: { type: 'quotation_no_reply', metadata: { path: ['stuckKey'], equals: stuckKey } },
      select: { id: true },
    });
    if (existing) continue;

    await notificationService.broadcastNotification({
      type: 'quotation_no_reply',
      title: `报价 ${qt.quotationNumber} 已发送 ${days} 天未回复`,
      body: `报价单 ${qt.quotationNumber}（客户 ${qt.customerName ?? '未指定'}，金额 ${Number(qt.totalAmount).toLocaleString('en-US')} ${qt.currency}）于 ${formatDate(sentMs)} 发出，至今已 ${days} 天未收到客户回复，请跟进确认。`,
      level: tier,
      link: `/quotations?id=${qt.id}`,
      metadata: { stuckKey, entityType: 'Quotation', entityId: qt.id, quotationId: qt.id, daysPending: days },
    });
    notified += 1;
  }

  if (notified > 0) {
    logger.info('[QuotationFollowUpWatchdog] scan', { notified });
  }
  return { notified };
}

export function createQuotationFollowUpWatchdogTask(): ScheduledTask {
  return {
    id: 'quotation_follow_up_watchdog',
    shouldRun: (now: Date) => {
      // 每日 11:30 后执行一次（与 11:00 的样品节点预警错峰）
      const dayKey = dayKeyOf(now);
      if ((now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() >= 30)) && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanQuotationFollowUps(prisma);
      } catch (e: any) {
        logger.error('[QuotationFollowUpWatchdog] failed', { error: e?.message });
      }
    },
  };
}
