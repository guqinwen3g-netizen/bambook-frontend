import { businessNowDate } from '../../shared/businessClock';
/**
 * C6 财务深化 — 调度任务：出口退税滞留预警
 *
 * 每日 10:30 后执行一次（日去重）。扫描在途（非终态、未软删）退税申报的滞留：
 *
 *   Submitted / Reviewing（税务审核滞留）：
 *     滞留 > 30 天 → warning；滞留 > 60 天 → critical
 *   Approved（已批未到账滞留）：
 *     滞留 > 60 天 → warning；滞留 > 90 天 → critical
 *
 * 滞留时钟取 updatedAt（状态机迁移必写 updatedAt，Submitted/Reviewing/Approved
 * 进入该态的时刻即最近一次迁移；滞留期间偶发备注编辑会重置时钟，属可接受近似，
 * 终态 Refunded/Rejected/Cancelled 不参与）。
 *
 * dedupKey：tax_refund_stall:${refundId}:${status}:${tier}
 * 幂等语义由 RiskAlert.dedupKey @unique 承担；状态迁移或级别跃迁产生新键，
 * 形成升级轨迹；同一状态同一级别不重复轰炸。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

interface StallRule {
  statuses: string[];
  phaseLabel: string;
  actionHint: string;
  warningDays: number;
  criticalDays: number;
}

const STALL_RULES: StallRule[] = [
  {
    statuses: ['Submitted', 'Reviewing'],
    phaseLabel: '税务审核',
    actionHint: '请跟进税务机关审核进度或补充资料',
    warningDays: 30,
    criticalDays: 60,
  },
  {
    statuses: ['Approved'],
    phaseLabel: '已批未到账',
    actionHint: '请核对国库退税到账情况，必要时查询退库进度',
    warningDays: 60,
    criticalDays: 90,
  },
];

/**
 * 扫描入口（watchdog 与测试直驱共用）：返回本次新产生的预警数。
 */
export async function scanTaxRefundStalls(prisma: PrismaClient, today: Date = businessNowDate()): Promise<{ alerted: number }> {
  const db = prisma as any;
  // 滞留时钟为 epoch ms（含时刻），与「当前时刻」对齐做差（非本地零点——日期串字段才用零点口径）
  const nowMs = today.getTime();
  const risk = createRiskService(prisma);

  const refunds = await db.taxRefund.findMany({
    where: { deletedAt: null, status: { in: ['Submitted', 'Reviewing', 'Approved'] } },
  });

  let alerted = 0;
  for (const tr of refunds) {
    const rule = STALL_RULES.find(r => r.statuses.includes(tr.status));
    if (!rule) continue;

    const clockMs = Number(tr.updatedAt);
    if (!Number.isFinite(clockMs) || clockMs <= 0) continue;
    const stallDays = Math.floor((nowMs - clockMs) / DAY_MS);

    let tier: AlertLevel | null = null;
    if (stallDays > rule.criticalDays) tier = 'critical';
    else if (stallDays > rule.warningDays) tier = 'warning';
    if (!tier) continue;

    const { created } = await risk.raiseAlert({
      type: 'tax_refund_stall',
      level: tier,
      title: `退税申报 ${tr.refundNumber} ${rule.phaseLabel}滞留 ${stallDays} 天`,
      content: `退税申报 ${tr.refundNumber} 当前状态 ${tr.status}，已滞留 ${stallDays} 天（阈值 ${rule.warningDays}/${rule.criticalDays} 天）${tr.refundAmount != null ? `，应退金额 ${tr.refundAmount} 元` : ''}。${rule.actionHint}。`,
      relatedType: 'TaxRefund',
      relatedId: tr.id,
      dedupKey: `tax_refund_stall:${tr.id}:${tr.status}:${tier}`,
    });
    if (created) alerted += 1;
  }

  if (alerted > 0) {
    logger.info('[TaxRefundStallWatchdog] scan', { alerted });
  }
  return { alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createTaxRefundStallWatchdogTask(): ScheduledTask {
  return {
    id: 'tax_refund_stall_watchdog',
    shouldRun: (now: Date) => {
      // 每日 10:30 后执行一次
      const dayKey = dayKeyOf(now);
      if ((now.getHours() > 10 || (now.getHours() === 10 && now.getMinutes() >= 30)) && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanTaxRefundStalls(prisma);
      } catch (e: any) {
        logger.error('[TaxRefundStallWatchdog] failed', { error: e?.message });
      }
    },
  };
}
