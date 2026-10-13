import { businessNowDate } from '../../shared/businessClock';
/**
 * M4 — 调度任务：信用评级定时重估（每日 09:45 后执行一次）
 *
 * 此前信用评级只能在前端手动点「评估该客户」触发（PRD 15.2 手工触发缺口）。
 * 本任务每日对全部 category=Customer 且未软删的 Relation 重估一次：
 *   - actorId=null（系统自动评估，CreditRating append-only 档案）
 *   - 日内幂等：当日零点（本地）之后已有评级的客户跳过，重复触发不产生重复行
 *   - 单客户失败不阻断其余客户（记 error 继续）
 *
 * 时序约定：排在 10:00 credit_risk_watchdog 之前，评级先刷新、冻结扫描后执行。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService } from '../../risk/riskService';
import { logger } from '../../lib/logger';

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

/** 全量客户重估主流程（导出供测试直接驱动） */
export async function reevaluateAllCustomerRatings(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<{ evaluated: number; skipped: number; failed: number }> {
  const risk = createRiskService(prisma);
  const dayStart = BigInt(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime());

  const relations = await (prisma as any).relation.findMany({
    where: { category: 'Customer', deletedAt: null },
    select: { id: true },
    take: 2000,
  });

  let evaluated = 0;
  let skipped = 0;
  let failed = 0;
  for (const rel of relations as Array<{ id: string }>) {
    try {
      const latest = await (prisma as any).creditRating.findFirst({
        where: { relationId: rel.id },
        orderBy: { evaluatedAt: 'desc' },
      });
      if (latest && BigInt(latest.evaluatedAt) >= dayStart) {
        skipped += 1;
        continue;
      }
      await risk.evaluateCreditRating(rel.id, null);
      evaluated += 1;
    } catch (e: any) {
      failed += 1;
      logger.error('[CreditRatingReevaluation] 单客户重估失败', { relationId: rel.id, error: e?.message });
    }
  }

  if (evaluated > 0 || skipped > 0 || failed > 0) {
    logger.info('[CreditRatingReevaluation] 定时重估完成', { evaluated, skipped, failed });
  }
  return { evaluated, skipped, failed };
}

export function createCreditRatingReevaluationTask(): ScheduledTask {
  return {
    id: 'credit_rating_reevaluation',
    shouldRun: (now: Date) => {
      // 每日 09:45 后执行一次
      const dayKey = dayKeyOf(now);
      const afterTime = now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 45);
      if (afterTime && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await reevaluateAllCustomerRatings(prisma);
      } catch (e: any) {
        logger.error('[CreditRatingReevaluation] failed', { error: e?.message });
      }
    },
  };
}
