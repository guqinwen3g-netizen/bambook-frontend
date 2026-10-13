import { businessNowDate } from '../../shared/businessClock';
/**
 * M4 — 调度任务：新报关单合规检查轮询（每 15 分钟）
 *
 * 此前报关单的 HS Code / 出口管制检查只能在前端手抄单号触发（PRD 15.3 手工触发缺口）。
 * 本任务轮询近 7 天创建的报关单，为缺失自动检查的报关单补跑：
 *   - 无 hs_code 检查记录 → runHsCodeCheck（系统自动，checkedById=null）
 *   - 无 export_control 检查记录 → runExportControlCheck
 *
 * 幂等真源：ComplianceCheck 为 append-only 档案且永不改写/删除，
 *   「该报关单是否已有同类型检查」的存在性检查即幂等闸门——不依赖内存水位，
 *   进程重启后自动补扫停机期间新建的报关单（自愈）。
 *
 * 边界约定：不改 server/src/customs/（创建侧即时钩子属报关域职责，本任务以轮询兜底）；
 *   单张报关单检查失败不阻断其余报关单（记 error 继续）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 轮询窗口：近 7 天创建的报关单（覆盖停机自愈场景） */
const POLL_WINDOW_DAYS = 7;
const POLL_BATCH_LIMIT = 200;
/** 轮询间隔：15 分钟 */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

let lastRunBucket = -1;

/** 轮询扫描主流程（导出供测试直接驱动） */
export async function scanNewDeclarationsForCompliance(
  prisma: PrismaClient,
  now: Date = businessNowDate(),
): Promise<{ scanned: number; hsRun: number; ecRun: number; failed: number }> {
  const risk = createRiskService(prisma);
  const sinceMs = BigInt(now.getTime() - POLL_WINDOW_DAYS * DAY_MS);

  const declarations = await (prisma as any).customsDeclaration.findMany({
    where: { deletedAt: null, createdAt: { gte: sinceMs } },
    orderBy: { createdAt: 'desc' },
    take: POLL_BATCH_LIMIT,
    select: { id: true },
  });

  let hsRun = 0;
  let ecRun = 0;
  let failed = 0;
  for (const decl of declarations as Array<{ id: string }>) {
    try {
      const hsExists = await (prisma as any).complianceCheck.findFirst({
        where: { type: 'hs_code', targetType: 'CustomsDeclaration', targetId: decl.id },
        select: { id: true },
      });
      if (!hsExists) {
        await risk.runHsCodeCheck(decl.id, null);
        hsRun += 1;
      }
    } catch (e: any) {
      failed += 1;
      logger.error('[CustomsComplianceWatchdog] HS 检查失败', { declarationId: decl.id, error: e?.message });
    }
    try {
      const ecExists = await (prisma as any).complianceCheck.findFirst({
        where: { type: 'export_control', targetType: 'CustomsDeclaration', targetId: decl.id },
        select: { id: true },
      });
      if (!ecExists) {
        await risk.runExportControlCheck(decl.id, null);
        ecRun += 1;
      }
    } catch (e: any) {
      failed += 1;
      logger.error('[CustomsComplianceWatchdog] 出口管制检查失败', { declarationId: decl.id, error: e?.message });
    }
  }

  if (hsRun > 0 || ecRun > 0 || failed > 0) {
    logger.info('[CustomsComplianceWatchdog] 新报关单合规检查完成', { scanned: declarations.length, hsRun, ecRun, failed });
  }
  return { scanned: declarations.length, hsRun, ecRun, failed };
}

export function createCustomsComplianceWatchdogTask(): ScheduledTask {
  return {
    id: 'customs_compliance_watchdog',
    shouldRun: (now: Date) => {
      // 每 15 分钟一次（进程启动后首个 tick 即执行，停机期间新单立即补扫）
      const bucket = Math.floor(now.getTime() / POLL_INTERVAL_MS);
      if (bucket !== lastRunBucket) {
        lastRunBucket = bucket;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanNewDeclarationsForCompliance(prisma);
      } catch (e: any) {
        logger.error('[CustomsComplianceWatchdog] failed', { error: e?.message });
      }
    },
  };
}
