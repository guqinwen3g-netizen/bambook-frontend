import { businessNowDate } from '../../shared/businessClock';
/**
 * C3 HR 深化 — 调度任务：试用转正 / 合同到期 预警
 *
 * 每日 09:00 后执行一次（日去重）。扫描在职员工档案（EmployeeProfile，
 * 排除 Resigned/Terminated 终态与软删）：
 *
 *   1. 试用转正提醒（employmentStatus = Probation 且 regularDate 可解析）：
 *      today >= regularDate - 7 天 → warning；today > regularDate → 升 critical。
 *      dedupKey：hr_lifecycle:${userId}:probation:${regularDate}:${tier}
 *   2. 合同到期提醒（contractEnd 非空可解析，不限合同类型）：
 *      today >= contractEnd - 30 天 → warning；today > contractEnd → 升 critical。
 *      dedupKey：hr_lifecycle:${userId}:contract:${contractEnd}:${tier}
 *
 * 一律经 riskService.raiseAlert（type 'hr_lifecycle'，relatedType 'EmployeeProfile'），
 * 幂等语义由 RiskAlert.dedupKey @unique 承担（tier 升级会产生新键，形成升级轨迹）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 试用转正预警窗口：转正日前 7 天 */
const PROBATION_WINDOW_DAYS = 7;
/** 合同到期预警窗口：到期日前 30 天 */
const CONTRACT_WINDOW_DAYS = 30;

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
export async function scanHrLifecycle(prisma: PrismaClient, today: Date = businessNowDate()): Promise<{ alerted: number }> {
  const db = prisma as any;
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const risk = createRiskService(prisma);

  const profiles = await db.employeeProfile.findMany({
    where: { deletedAt: null, employmentStatus: { notIn: ['Resigned', 'Terminated'] } },
    include: { user: true },
  });

  let alerted = 0;
  for (const p of profiles) {
    const name = p.user?.displayName ?? p.userId;
    const label = `${name}（${p.employeeNo}）`;

    // ─── 试用转正：Probation 且 regularDate 进入 7 天窗口 ───
    if (p.employmentStatus === 'Probation') {
      const regularMs = parseDate(p.regularDate);
      if (regularMs !== null && todayMs >= regularMs - PROBATION_WINDOW_DAYS * DAY_MS) {
        const tier: AlertLevel = todayMs > regularMs ? 'critical' : 'warning';
        const daysLeft = Math.floor((regularMs - todayMs) / DAY_MS);
        const note = daysLeft >= 0 ? `距转正日仅剩 ${daysLeft} 天` : `已超转正日 ${-daysLeft} 天`;
        const { created } = await risk.raiseAlert({
          type: 'hr_lifecycle',
          level: tier,
          title: `员工 ${label} 试用期${daysLeft >= 0 ? '即将到期' : '已超期'}，${note}`,
          content: `员工 ${label} 试用期转正日期为 ${p.regularDate}，${note}，请及时办理转正评估或延期手续。`,
          relatedType: 'EmployeeProfile',
          relatedId: p.id,
          dedupKey: `hr_lifecycle:${p.userId}:probation:${p.regularDate}:${tier}`,
        });
        if (created) alerted += 1;
      }
    }

    // ─── 合同到期：contractEnd 进入 30 天窗口 ───
    const contractMs = parseDate(p.contractEnd);
    if (contractMs !== null && todayMs >= contractMs - CONTRACT_WINDOW_DAYS * DAY_MS) {
      const tier: AlertLevel = todayMs > contractMs ? 'critical' : 'warning';
      const daysLeft = Math.floor((contractMs - todayMs) / DAY_MS);
      const note = daysLeft >= 0 ? `距合同到期仅剩 ${daysLeft} 天` : `合同已过期 ${-daysLeft} 天`;
      const { created } = await risk.raiseAlert({
        type: 'hr_lifecycle',
        level: tier,
        title: `员工 ${label} 劳动合同${daysLeft >= 0 ? '即将到期' : '已过期'}，${note}`,
        content: `员工 ${label} 劳动合同（${p.contractType ?? '类型未填'}）到期日为 ${p.contractEnd}，${note}，请及时安排续签或终止流程。`,
        relatedType: 'EmployeeProfile',
        relatedId: p.id,
        dedupKey: `hr_lifecycle:${p.userId}:contract:${p.contractEnd}:${tier}`,
      });
      if (created) alerted += 1;
    }
  }

  if (alerted > 0) {
    logger.info('[HrLifecycleWatchdog] scan', { alerted });
  }
  return { alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createHrLifecycleWatchdogTask(): ScheduledTask {
  return {
    id: 'hr_lifecycle_watchdog',
    shouldRun: (now: Date) => {
      // 每日 09:00 后执行一次
      const dayKey = dayKeyOf(now);
      if (now.getHours() >= 9 && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanHrLifecycle(prisma);
      } catch (e: any) {
        logger.error('[HrLifecycleWatchdog] failed', { error: e?.message });
      }
    },
  };
}
