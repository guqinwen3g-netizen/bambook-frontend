import { businessNowDate } from '../../shared/businessClock';
/**
 * A5 报表引擎 — 调度任务：定时报表运行器
 *
 * 每小时扫描 enabled 且带 schedule 的报表定义，按周期键幂等触发：
 *   - daily   → 周期键 YYYY-MM-DD
 *   - weekly  → 周期键 YYYY-Www（ISO 8601 周）
 *   - monthly → 周期键 YYYY-MM
 *
 * 幂等保证（双层）：
 *   1. 查询层：同 idempotencyKey 已有 ReportRun → 跳过
 *   2. 约束层：ReportRun.idempotencyKey unique，并发重复创建 P2002 → 按已运行处理
 *
 * 失败语义：单定义失败不阻断其他定义；失败记录落 ReportRun(status=Failed)
 * 供运行历史排查；不自动重试（下一小时 tick 看到同周期已存在记录即跳过，
 * 避免重复轰炸——失败需人工在报表中心重新触发）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { logger } from '../../lib/logger';
import { periodKeyFor, ReportSchedule } from '../../reporting/reportEngine';
import { runReportDefinition } from '../../reporting/reportDefinitionService';

const BATCH_LIMIT = 50;

let lastRunHour = -1;

/** 扫描 + 触发主流程（导出供测试直接驱动）。@returns 实际执行的运行数（跳过不计） */
export async function runDueReports(
  prisma: PrismaClient,
  now: Date = businessNowDate(),
): Promise<number> {
  const definitions = await (prisma as any).reportDefinition.findMany({
    where: { deletedAt: null, enabled: true, schedule: { not: null } },
    select: { id: true, schedule: true },
    take: BATCH_LIMIT,
  });

  let executed = 0;
  for (const def of definitions) {
    const schedule = def.schedule as ReportSchedule;
    const idempotencyKey = `${def.id}:${periodKeyFor(schedule, now)}`;
    try {
      const result = await runReportDefinition({
        prisma,
        definitionId: def.id,
        trigger: 'schedule',
        idempotencyKey,
      });
      if (result.ok && !result.data!.skipped) executed++;
      if (!result.ok) {
        logger.warn('[ScheduledReport] run rejected', { definitionId: def.id, code: result.error!.code });
      }
    } catch (e: any) {
      logger.error('[ScheduledReport] definition failed', { definitionId: def.id, error: e?.message });
    }
  }

  if (executed > 0) {
    logger.info('[ScheduledReport] reports executed', { count: executed });
  }
  return executed;
}

export function createScheduledReportRunnerTask(): ScheduledTask {
  return {
    id: 'scheduled_report_runner',
    shouldRun: (now: Date) => {
      const hour = now.getHours();
      if (hour !== lastRunHour) {
        lastRunHour = hour;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await runDueReports(prisma);
      } catch (e: any) {
        logger.error('[ScheduledReport] failed', { error: e?.message });
      }
    },
  };
}

/** 测试辅助：重置小时去重状态 */
export function __resetScheduledReportRunnerState(): void {
  lastRunHour = -1;
}
