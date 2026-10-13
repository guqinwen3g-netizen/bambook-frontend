import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 E / E2 — 调度任务：每周经营 briefing
 *
 * 每周一 09:30 推送上周（周一~周日）经营周报（type: 'weekly_briefing'）：
 *   - 销售概览（区间订单数 + 承揽额分币种）与环比（vs 上上周）
 *   - 销售排行 / 客户贡献 Top3
 *   - 区间毛利（分币种）与亏损订单数
 *   - 应收/应付逾期快照、汇率损益
 *   - 风险分级：长账龄逾期 / 负毛利订单 / 销售环比下滑 >30% → warning
 *
 * 组装逻辑统一由 briefingService.buildWeeklyBriefing 提供（单一权威源，可单测）。
 * 周一 09:30 触发（错开日报 09:00，避免两简报同刻到达）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { buildWeeklyBriefing } from '../../briefing/briefingService';
import { logger } from '../../lib/logger';

const BRIEFING_HOUR = 9;
const BRIEFING_MINUTE = 30;
let lastBriefingDate = ''; // YYYY-MM-DD 本地日期，防同日重复

export function createWeeklyBriefingTask(): ScheduledTask {
  return {
    id: 'weekly_briefing',
    shouldRun: (now: Date) => {
      if (now.getDay() !== 1) return false; // 仅周一
      if (now.getHours() < BRIEFING_HOUR) return false;
      if (now.getHours() === BRIEFING_HOUR && now.getMinutes() < BRIEFING_MINUTE) return false;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return today !== lastBriefingDate;
    },
    run: async (prisma: PrismaClient) => {
      const now = businessNowDate();
      lastBriefingDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      try {
        const briefing = await buildWeeklyBriefing(prisma, now);
        const notificationService = createNotificationService(prisma);
        await notificationService.broadcastNotification({
          type: 'weekly_briefing',
          title: briefing.title,
          body: briefing.body,
          level: briefing.level,
          link: '/dashboard',
          metadata: briefing.metadata,
        });
        logger.info('[WeeklyBriefing] sent', { from: briefing.metadata.from, to: briefing.metadata.to, level: briefing.level });
      } catch (e: any) {
        logger.error('[WeeklyBriefing] failed', { error: e?.message });
      }
    },
  };
}
