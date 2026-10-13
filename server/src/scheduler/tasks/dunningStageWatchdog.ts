/**
 * P0-2 催款分级 — 调度任务：催款分级自动升级 watchdog
 *
 * 每日 09:45 后执行一次（日去重）。经 dunningStageService.scanAndSync 扫描
 * 账龄应收行 + P0-1 逾期尾款，回写 DunningProfile（autoStage/生效分级/停驻时长）；
 * 本次发生升级（rank 上升）的客户×币种 → riskService.raiseAlert 通知责任人：
 *
 *   reminder（d1-30）  → info      温和提醒档
 *   firm（d31-60）     → warning   正式催款档
 *   urgent（d61-90）   → critical  严催档（暂停供货风险）
 *   legal（d90+）      → critical  法务准备档
 *
 * dedupKey：dunning_stage:{scopeKey}:{stage}（tier 升级产生新键形成升级轨迹，
 * 与 crm_followup / lc_maturity watchdog 同口径）。manual 钉住期间 auto 升级
 * 穿透同样告警（aging 证据压过人工降级，见 dunningStageService.resolveEffectiveStage）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { createDunningStageService, STAGE_LABELS_ZH, STAGE_AGING_DESC, type DunningStage } from '../../finance/dunningStageService';
import { logger } from '../../lib/logger';

/** 升级告警级别：严催及以上 critical（资金风险），催款 warning，提醒 info */
function alertLevelOfStage(stage: DunningStage): AlertLevel {
  if (stage === 'legal' || stage === 'urgent') return 'critical';
  if (stage === 'firm') return 'warning';
  return 'info';
}

/**
 * 扫描入口（watchdog 与测试直驱共用）：同步 DunningProfile 主档并对本次升级告警。
 */
export async function scanDunningStages(prisma: PrismaClient): Promise<{ scanned: number; escalated: number; alerted: number }> {
  const risk = createRiskService(prisma);
  const stageService = createDunningStageService(prisma);

  const { scanned, escalated, rows } = await stageService.scanAndSync();
  let alerted = 0;
  for (const change of rows) {
    const stage = change.to as DunningStage;
    const owner = change.ownerName ? `（责任人：${change.ownerName}）` : '';
    // ★ B252：金额只念一遍 —— overdueAmount 已是"账龄逾期 + 未计到的尾款"的唯一口径；
    //   "未开票尾款"这一句只在真的有一段没挂在发票上时才出现（挂在逾期发票上的那段不再重复出现）。
    const uncounted = change.finalPaymentUncounted;
    const debt = uncounted > 0
      ? `逾期账款 ${change.overdueAmount} ${change.currency}（含未开票尾款 ${uncounted}）`
      : `逾期账款 ${change.overdueAmount} ${change.currency}`;
    const { created } = await risk.raiseAlert({
      type: 'dunning_stage',
      level: alertLevelOfStage(stage),
      title: `客户 ${change.customerName} 催款分级升至「${STAGE_LABELS_ZH[stage]}」（${STAGE_AGING_DESC[stage]}）`,
      content: `客户 ${change.customerName} 的逾期款项催款分级已由「${STAGE_LABELS_ZH[(change.from as DunningStage)] ?? change.from}」自动升级为「${STAGE_LABELS_ZH[stage]}」（${STAGE_AGING_DESC[stage]}），${debt}${owner}。请按分级执行催款动作（分级函模板/升级动作），并跟进回款。`,
      relatedType: 'DunningProfile',
      relatedId: change.scopeKey,
      dedupKey: `dunning_stage:${change.scopeKey}:${stage}`,
    });
    if (created) alerted += 1;
  }

  if (escalated > 0) {
    logger.info('[DunningStageWatchdog] scan', { scanned, escalated, alerted });
  }
  return { scanned, escalated, alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createDunningStageWatchdogTask(): ScheduledTask {
  return {
    id: 'dunning_stage_watchdog',
    shouldRun: (now: Date) => {
      // 每日 09:45 后执行一次（避开 09:30 CRM / 10:00 信用证档位）
      const dayKey = dayKeyOf(now);
      if ((now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 45)) && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanDunningStages(prisma);
      } catch (e: any) {
        logger.error('[DunningStageWatchdog] failed', { error: e?.message });
      }
    },
  };
}
