import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 H H1c — 调度任务：工厂认证到期预警
 *
 * 每日扫描 FactoryCertification.validUntil，按剩余天数分级通知：
 *   - 30 天 info → 14 天 warning → 已过期 critical
 *
 * 业务规则：
 *   - validUntil 为 null = 长期有效，不预警
 *   - 已软删的认证/工厂档案不预警
 *   - 分级去重：dedupKey 含 tier，同级别当天只发一次；级别升级会重新通知
 *
 * 日期字段为 String YYYY-MM-DD（本地日历日比较，避免时区漂移）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { logger } from '../../lib/logger';
import { localDateKey } from '../../shared/localDate';


const DAY_MS = 24 * 60 * 60 * 1000;

type Tier = 'info' | 'warning' | 'critical';

function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

function tierFor(days: number): Tier | null {
  if (days < 0) return 'critical';
  if (days <= 14) return 'warning';
  if (days <= 30) return 'info';
  return null;
}

/**
 * 扫描 + 通知主流程（导出供测试直接驱动）。
 * @returns 发送的通知数
 */
export async function detectAndNotify(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<number> {
  const notificationService = createNotificationService(prisma);
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 扫描窗口：已过期 ~ 未来 30 天（分级在 tierFor 内完成）
  const from = '1970-01-01';
  const to = localDateKey(new Date(todayMs + 30 * DAY_MS));
  const certs = await (prisma as any).factoryCertification.findMany({
    where: { deletedAt: null, validUntil: { gte: from, lte: to }, factory: { deletedAt: null } },
    include: { factory: { include: { relation: true } } },
    orderBy: { validUntil: 'asc' },
    take: 100,
  });

  let sent = 0;
  for (const cert of certs) {
    const validMs = parseDate(cert.validUntil);
    if (validMs === null) continue;
    const days = Math.round((validMs - todayMs) / DAY_MS);
    const tier = tierFor(days);
    if (!tier) continue;

    const factoryName = cert.factory?.relation?.name || cert.factoryId;
    const dedupKey = `expiry:factory_certification:${cert.id}:${tier}:${todayStr}`;
    const existing = await prisma.notification.findFirst({
      where: { type: 'factory_certification_expiring', metadata: { path: ['expiryKey'], equals: dedupKey } },
      select: { id: true },
    });
    if (existing) continue;

    await notificationService.broadcastNotification({
      type: 'factory_certification_expiring',
      title: days < 0 ? `工厂认证已过期：${factoryName} ${cert.type}` : `工厂认证即将到期：${factoryName} ${cert.type}（${days} 天）`,
      body: days < 0
        ? `工厂 ${factoryName} 的 ${cert.type} 认证已于 ${cert.validUntil} 过期，请立即确认复审状态，避免影响客户验厂。`
        : `工厂 ${factoryName} 的 ${cert.type} 认证有效期至 ${cert.validUntil}，剩余 ${days} 天，请提前安排复审。`,
      level: tier,
      link: `/suppliers?id=${cert.factoryId}`,
      metadata: {
        expiryKey: dedupKey,
        entityType: 'FactoryCertification',
        entityId: cert.id,
        factoryId: cert.factoryId,
        factoryName,
        certType: cert.type,
        daysRemaining: days,
        deadline: cert.validUntil,
        tier,
      },
    });
    sent++;
  }

  if (sent > 0) {
    logger.info('[FactoryCertWatchdog] notifications sent', { count: sent });
  }
  return sent;
}

let lastRunDay = '';

export function createFactoryCertificationWatchdogTask(): ScheduledTask {
  return {
    id: 'factory_certification_watchdog',
    shouldRun: (now: Date) => {
      // 每日 08:00 后执行一次
      const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      if (now.getHours() >= 8 && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await detectAndNotify(prisma);
      } catch (e: any) {
        logger.error('[FactoryCertWatchdog] failed', { error: e?.message });
      }
    },
  };
}
