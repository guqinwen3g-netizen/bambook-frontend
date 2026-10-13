import { businessNowDate } from '../../shared/businessClock';
/**
 * C1 CRM 深化 — 调度任务：客户跟进逾期预警
 *
 * 每日 09:30 后执行一次（日去重）。扫描下次跟进日期（FollowUpRecord.nextFollowUpAt）
 * 已过期且未软删的跟进记录：
 *
 *   today > nextFollowUpAt       → warning（刚逾期）
 *   today > nextFollowUpAt + 7天 → critical（严重逾期）
 *
 * dedupKey：crm_followup:${followUpId}:${nextFollowUpAt}:${tier}
 *
 * 一律经 riskService.raiseAlert（type 'crm_follow_up_overdue'，relatedType
 * 'FollowUpRecord'），幂等语义由 RiskAlert.dedupKey @unique 承担（tier 升级会产生
 * 新键，形成升级轨迹）。与样品交期 / HR 生命周期预警同口径。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 严重逾期阈值：超过下次跟进日期 7 天升为 critical */
const CRITICAL_OVERDUE_DAYS = 7;

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
export async function scanCrmFollowUps(prisma: PrismaClient, today: Date = businessNowDate()): Promise<{ alerted: number }> {
  const db = prisma as any;
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const risk = createRiskService(prisma);

  const followUps = await db.followUpRecord.findMany({
    where: { deletedAt: null, nextFollowUpAt: { not: null } },
    include: { relation: { select: { name: true } } },
  });

  let alerted = 0;
  for (const fu of followUps) {
    const nextMs = parseDate(fu.nextFollowUpAt);
    if (nextMs === null || todayMs <= nextMs) continue; // 未逾期

    const overdueDays = Math.floor((todayMs - nextMs) / DAY_MS);
    const tier: AlertLevel = overdueDays > CRITICAL_OVERDUE_DAYS ? 'critical' : 'warning';
    const relationName = fu.relation?.name ?? fu.relationId;
    const topic = fu.nextFollowUpTopic ? `，主题：${fu.nextFollowUpTopic}` : '';

    const { created } = await risk.raiseAlert({
      type: 'crm_follow_up_overdue',
      level: tier,
      title: `客户 ${relationName} 跟进已逾期 ${overdueDays} 天`,
      content: `客户 ${relationName} 的下次跟进日期为 ${fu.nextFollowUpAt}，已逾期 ${overdueDays} 天${topic}，请及时跟进维护客情。`,
      relatedType: 'FollowUpRecord',
      relatedId: fu.id,
      dedupKey: `crm_followup:${fu.id}:${fu.nextFollowUpAt}:${tier}`,
    });
    if (created) alerted += 1;
  }

  if (alerted > 0) {
    logger.info('[CrmFollowUpWatchdog] scan', { alerted });
  }
  return { alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createCrmFollowUpWatchdogTask(): ScheduledTask {
  return {
    id: 'crm_follow_up_watchdog',
    shouldRun: (now: Date) => {
      // 每日 09:30 后执行一次
      const dayKey = dayKeyOf(now);
      if ((now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 30)) && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanCrmFollowUps(prisma);
      } catch (e: any) {
        logger.error('[CrmFollowUpWatchdog] failed', { error: e?.message });
      }
    },
  };
}
