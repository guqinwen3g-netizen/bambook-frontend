/**
 * 调度任务：大宗原料行情自动同步（羊毛 = IMF 月度 / 亚麻 = 欧洲亚麻联盟季度）
 *
 * ── 为什么是「自动」而不是人工录入 ─────────────────────────────────
 * Kevin（2026-09-19）：「不能手动填，要找到自动同步接入的方法」。
 * 两个源的选择过程与实测排除清单见 `market/autoQuoteSources.ts` 的文件头注释。
 *
 * ── 节奏 ──────────────────────────────────────────────────────────
 * 每日 **09:10** 后跑一次（`fx_rate_sync` 是 08:30 ⇒ 折算用的汇率已经落库）。
 * 日内按本地日去重：一天最多跑一次；失败不重试刷屏（明天再来）。
 * ⚠️ 源本身的节奏是月度/季度 ⇒ 绝大多数日子里「拿到的是同一个数」，
 *    这是**正常**的（不是同步没生效）。界面按 `asOf` 显示数据月份。
 *
 * ── 失败语义（硬约束）─────────────────────────────────────────────
 * 任一源失败 ⇒ **不写配置**（保留上一次的好值），只记 warn。
 * 任务绝不抛错、绝不写 null/兜底数字 —— 最坏情况是数据旧，不是数字错。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { getSystemConfigService } from '../../config/systemConfigService';
import { runAutoQuoteSync } from '../../market/autoQuoteSources';
import { logger } from '../../lib/logger';

let lastRunBucket = '';

/** 只在调度器的进程内共享，用于同日去重 */
function localDayBucket(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export interface MarketQuoteSyncOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
}

/** 主流程（导出供测试 / 路由「立即同步」直接驱动）；任何失败路径都不抛错 */
export async function runMarketQuoteSync(
  prisma: PrismaClient,
  opts: MarketQuoteSyncOptions = {},
) {
  const svc = getSystemConfigService(prisma);
  try {
    const report = await runAutoQuoteSync(prisma, svc, { fetchImpl: opts.fetchImpl, now: opts.now });
    if (report.failed.length) {
      logger.warn('[MarketQuoteSync] 部分行情源未同步（保留旧值）', {
        ok: report.ok,
        failed: report.failed,
        skipped: report.skipped,
      });
    } else {
      logger.info('[MarketQuoteSync] 行情同步完成', { ok: report.ok });
    }
    return report;
  } catch (e: any) {
    logger.error('[MarketQuoteSync] 同步异常（未写任何值）', { error: e?.message });
    return { ok: [], failed: [{ key: 'wool' as const, reason: `unexpected: ${e?.message}` }], skipped: [] };
  }
}

export function createMarketQuoteSyncTask(): ScheduledTask {
  return {
    id: 'market_quote_sync',
    timeDomain: 'wall',
    shouldRun: (now: Date) => {
      const afterTime = now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 10);
      const bucket = localDayBucket(now);
      if (afterTime && bucket !== lastRunBucket) {
        lastRunBucket = bucket;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await runMarketQuoteSync(prisma);
      } catch (e: any) {
        logger.error('[MarketQuoteSync] failed', { error: e?.message });
      }
    },
  };
}
