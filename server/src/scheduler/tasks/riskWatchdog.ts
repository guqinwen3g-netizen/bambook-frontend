/**
 * 阶段 H / H3 — 调度任务：风险巡检（信用风险 + 重复疵点）
 *
 * 两个 watchdog 合置一文件（共用 RiskService 与日去重模式）：
 *
 *   1. creditRiskWatchdog（每日 10:00 后执行一次）：
 *      调 runCreditRiskScan() —— 客户最大逾期 > 60 天冻结其 Active 信用额度
 *      并 credit_frozen 预警（按日去重）；单张发票逾期 > 180 天记 bad_debt
 *      预警（dedupKey 唯一，只报一次）。
 *
 *   2. qualityRepeatWatchdog（每日 10:30 后执行一次）：
 *      调 runQualityRepeatScan() —— 近 90 天同工厂同疵点词出现在 ≥2 张
 *      验货报告 → quality_repeat 预警（dedupKey 含季度，季度内幂等）。
 *
 * 幂等语义由 RiskAlert.dedupKey @unique 承担，watchdog 本身只做日级触发去重。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService } from '../../risk/riskService';
import { logger } from '../../lib/logger';

let lastCreditRunDay = '';
let lastQualityRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createCreditRiskWatchdogTask(): ScheduledTask {
  return {
    id: 'credit_risk_watchdog',
    shouldRun: (now: Date) => {
      // 每日 10:00 后执行一次
      const dayKey = dayKeyOf(now);
      if (now.getHours() >= 10 && dayKey !== lastCreditRunDay) {
        lastCreditRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await createRiskService(prisma).runCreditRiskScan();
      } catch (e: any) {
        logger.error('[CreditRiskWatchdog] failed', { error: e?.message });
      }
    },
  };
}

export function createQualityRepeatWatchdogTask(): ScheduledTask {
  return {
    id: 'quality_repeat_watchdog',
    shouldRun: (now: Date) => {
      // 每日 10:30 后执行一次
      const dayKey = dayKeyOf(now);
      const afterHalfTen = now.getHours() > 10 || (now.getHours() === 10 && now.getMinutes() >= 30);
      if (afterHalfTen && dayKey !== lastQualityRunDay) {
        lastQualityRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await createRiskService(prisma).runQualityRepeatScan();
      } catch (e: any) {
        logger.error('[QualityRepeatWatchdog] failed', { error: e?.message });
      }
    },
  };
}
