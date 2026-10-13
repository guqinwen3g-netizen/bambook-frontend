import { businessNowDate } from '../../shared/businessClock';
/**
 * Phase 0 Sprint 2 → 阶段 E / E2 升级 — 调度任务：每日经营 briefing
 *
 * 每天 09:00 推送每日经营摘要（type: 'daily_briefing'）：
 *   - 昨日动态：近 24h 订单/发货/开票/收款计数
 *   - 在手订单敞口（承揽口径，分币种）
 *   - 应收逾期快照（B2 账龄，含最大逾期户）
 *   - 本月毛利（C1 口径，分币种 + 亏损订单数）
 *   - 风险分级：长账龄逾期（d61+）或负毛利订单存在 → warning
 *
 * 组装逻辑统一由 briefingService.buildDailyBriefing 提供（单一权威源，可单测），
 * 本任务只负责调度时序（09:00 防重）与通知推送。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { buildDailyBriefing } from '../../briefing/briefingService';
import { logger } from '../../lib/logger';

const BRIEFING_HOUR = 9; // 每天 09:00
let lastBriefingDate = ''; // YYYY-MM-DD 本地日期，防同日重复

export function createDailyBriefingTask(): ScheduledTask {
  return {
    id: 'daily_briefing',
    shouldRun: (now: Date) => {
      if (now.getHours() < BRIEFING_HOUR) return false;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return today !== lastBriefingDate;
    },
    run: async (prisma: PrismaClient) => {
      const now = businessNowDate();
      lastBriefingDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      try {
        const briefing = await buildDailyBriefing(prisma, now);
        const notificationService = createNotificationService(prisma);
        // 2026-09-02 敏感外溢修复：简报正文含本月毛利明文，原 broadcastNotification
        // 推全员——与驾驶舱 sensitive:profit 遮罩口径矛盾（业务员不该收到毛利数字）。
        // 改为定向推送给持有 sensitive:profit scope 的活跃用户（管理层）。
        const recipients = await prisma.userAccount.findMany({
          where: {
            deletedAt: null,
            status: 'active',
            roles: { some: { role: { permissions: { some: { permission: { scope: 'sensitive:profit' } } } } } },
          },
          select: { id: true },
        });
        for (const user of recipients) {
          await notificationService.createNotification({
            userId: user.id,
            type: 'daily_briefing',
            title: briefing.title,
            body: briefing.body,
            level: briefing.level,
            link: '/dashboard',
            metadata: briefing.metadata,
          });
        }
        logger.info('[DailyBriefing] sent', { date: briefing.metadata.date, level: briefing.level, recipients: recipients.length });
      } catch (e: any) {
        logger.error('[DailyBriefing] failed', { error: e?.message });
      }
    },
  };
}
