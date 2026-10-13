import { businessNowDate } from '../../shared/businessClock';
/**
 * C6 财务深化 — 调度任务：信用证三期预警
 *
 * 每日 10:00 后执行一次（日去重）。扫描未终态（非 Settled/Expired/Cancelled）
 * 且未软删信用证的三个业务期限字段：
 *
 *   shipmentDeadline     最迟装运期
 *   presentationDeadline 交单期限
 *   expiryDate           信用证有效期
 *
 * 分级语义（与 CRM 跟进 / 样品交期预警同口径，预警不改业务状态）：
 *
 *   期限在未来且 ≤ 7 天 → warning（临近，需安排装运/交单/展期）
 *   期限已过            → critical（已逾期，信用证面临不符点/失效风险）
 *
 * dedupKey：lc_maturity:${lcId}:${fieldKey}:${deadline}:${tier}
 * 幂等语义由 RiskAlert.dedupKey @unique 承担；期限变更或级别跃迁产生新键，
 * 形成升级轨迹；同一期限同一级别日级不重复。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 临近窗口：期限距今日 ≤ 7 天升 warning */
const APPROACHING_DAYS = 7;
/** 信用证终态（不参与三期预警） */
const TERMINAL_STATUSES = ['Settled', 'Expired', 'Cancelled'];

const DEADLINE_FIELDS: Array<{ key: 'shipmentDeadline' | 'presentationDeadline' | 'expiryDate'; label: string }> = [
  { key: 'shipmentDeadline', label: '最迟装运期' },
  { key: 'presentationDeadline', label: '交单期限' },
  { key: 'expiryDate', label: '有效期' },
];

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
export async function scanLcMaturity(prisma: PrismaClient, today: Date = businessNowDate()): Promise<{ alerted: number }> {
  const db = prisma as any;
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const risk = createRiskService(prisma);

  const lcs = await db.letterOfCredit.findMany({
    where: { deletedAt: null, status: { notIn: TERMINAL_STATUSES } },
  });

  let alerted = 0;
  for (const lc of lcs) {
    for (const field of DEADLINE_FIELDS) {
      const deadline: string | null = lc[field.key];
      const deadlineMs = parseDate(deadline);
      if (deadlineMs === null) continue;

      const diffDays = Math.floor((deadlineMs - todayMs) / DAY_MS);
      let tier: AlertLevel;
      let timing: string;
      if (diffDays < 0) {
        tier = 'critical';
        timing = `已逾期 ${-diffDays} 天`;
      } else if (diffDays <= APPROACHING_DAYS) {
        tier = 'warning';
        timing = diffDays === 0 ? '今日到期' : `仅剩 ${diffDays} 天`;
      } else {
        continue; // 窗口外
      }

      const { created } = await risk.raiseAlert({
        type: 'lc_maturity',
        level: tier,
        title: `信用证 ${lc.lcNumber} ${field.label}${timing}`,
        content: `信用证 ${lc.lcNumber}（当前节点 ${lc.status}）的${field.label}为 ${deadline}，${timing}。请及时安排${field.key === 'shipmentDeadline' ? '装运' : field.key === 'presentationDeadline' ? '交单议付' : '业务收尾或展期'}，避免不符点或信用证失效。`,
        relatedType: 'LetterOfCredit',
        relatedId: lc.id,
        dedupKey: `lc_maturity:${lc.id}:${field.key}:${deadline}:${tier}`,
      });
      if (created) alerted += 1;
    }
  }

  if (alerted > 0) {
    logger.info('[LcMaturityWatchdog] scan', { alerted });
  }
  return { alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createLcMaturityWatchdogTask(): ScheduledTask {
  return {
    id: 'lc_maturity_watchdog',
    shouldRun: (now: Date) => {
      // 每日 10:00 后执行一次
      const dayKey = dayKeyOf(now);
      if (now.getHours() >= 10 && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanLcMaturity(prisma);
      } catch (e: any) {
        logger.error('[LcMaturityWatchdog] failed', { error: e?.message });
      }
    },
  };
}
