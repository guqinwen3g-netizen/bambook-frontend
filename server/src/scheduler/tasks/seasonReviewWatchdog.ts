import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 H H2 — 调度任务：季度回顾自动生成
 *
 * 每日扫描 Season：endDate 已过（YYYY-MM-DD 字符串比较）且 reviewJson 为 null
 * 且未软删 → 逐个 generateSeasonReview（订单实时聚合快照落 reviewJson）。
 *
 * 业务规则：
 *   - 已有 reviewJson 的季度跳过（快照可由 POST /:id/review 手动重生成）
 *   - 单条生成失败 catch 住继续，不阻断其他季度
 *   - 日期字段为 String YYYY-MM-DD（本地日历日比较，避免时区漂移）
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createSeasonService } from '../../seasons/seasonService';
import { logger } from '../../lib/logger';

function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 扫描 + 生成主流程（导出供测试直接驱动）。
 * @returns 成功生成回顾的季度数
 */
export async function generatePendingSeasonReviews(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<number> {
  const todayStr = fmtLocalDate(today);
  const seasons = await (prisma as any).season.findMany({
    where: { deletedAt: null, reviewJson: Prisma.DbNull, endDate: { lt: todayStr } },
    orderBy: { endDate: 'asc' },
    take: 100,
  });

  const service = createSeasonService(prisma);
  let generated = 0;
  for (const season of seasons) {
    try {
      await service.generateSeasonReview(season.id, 'system');
      generated++;
    } catch (e: any) {
      logger.error('[SeasonReviewWatchdog] generate failed', { seasonId: season.id, code: season.code, error: e?.message });
    }
  }

  if (generated > 0) {
    logger.info('[SeasonReviewWatchdog] season reviews generated', { count: generated });
  }
  return generated;
}

let lastRunDay = '';

export function createSeasonReviewWatchdogTask(): ScheduledTask {
  return {
    id: 'season_review_watchdog',
    shouldRun: (now: Date) => {
      // 每日 09:00 后执行一次
      const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      if (now.getHours() >= 9 && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await generatePendingSeasonReviews(prisma);
      } catch (e: any) {
        logger.error('[SeasonReviewWatchdog] failed', { error: e?.message });
      }
    },
  };
}
