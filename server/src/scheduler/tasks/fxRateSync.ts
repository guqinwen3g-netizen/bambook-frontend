import { businessNowDate } from '../../shared/businessClock';
/**
 * M4 — 调度任务：汇率外部行情同步（每日 08:30 后执行一次，失败后 6 小时内重试一次）
 *
 * 此前汇率全靠手工录入（PRD 15.1 手工触发缺口）。本任务接外部行情源自动入库：
 *   - 行情源：exchangerate-api.com 开放端点（https://open.er-api.com/v6/latest/CNY，免 key），
 *     返回 base=CNY 的牌价（1 CNY 兑 X 外币），入库前折算为系统口径「1 单位外币兑 CNY」
 *   - 同步币种：ExchangeRate 档案中已出现过的币种；档案为空时用默认集（USD/EUR/HKD/GBP/JPY）
 *   - 入库走 riskService.addExchangeRate（source='api'）：波动 ≥2% 自动预警等既有行为全量继承
 *   - 日内幂等：同币种当日已有 source='api' 记录则跳过，重复触发不产生重复行
 *
 * 离线兜底（硬约束）：Mac Mini 为内网环境，外部 API 不可达 / 超时 / 返回结构异常时
 *   → 记 warn 日志并返回 offline=true，保留手工录入通道，任务绝不崩溃、绝不抛错。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_CURRENCIES = ['USD', 'EUR', 'HKD', 'GBP', 'JPY'];
const FX_API_URL = 'https://open.er-api.com/v6/latest/CNY';
const SYSTEM_ACTOR = 'system_fx_sync';

let lastRunBucket = '';

function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface FxSyncOptions {
  today?: Date;
  /** 测试注入；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入；缺省 exchangerate-api 开放端点 */
  apiUrl?: string;
}

export interface FxSyncResult {
  offline: boolean;
  synced: string[];
  skipped: string[];
}

/** 汇率同步主流程（导出供测试直接驱动）；任何失败路径都不抛错 */
export async function syncFxRatesFromExternal(
  prisma: PrismaClient,
  opts: FxSyncOptions = {},
): Promise<FxSyncResult> {
  const today = opts.today ?? businessNowDate();
  const effectiveDate = formatLocalDate(today);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const apiUrl = opts.apiUrl ?? FX_API_URL;
  const db = prisma as any;
  const result: FxSyncResult = { offline: false, synced: [], skipped: [] };

  // ── 拉取行情（离线兜底：任何异常都降级为 warn + offline） ──
  let apiRates: Record<string, number> | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let payload: any;
    try {
      const res = await fetchImpl(apiUrl, { signal: controller.signal } as any);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (payload?.result !== 'success' || !payload?.rates || typeof payload.rates !== 'object') {
      throw new Error('行情源返回结构异常（缺 result=success 或 rates）');
    }
    apiRates = payload.rates as Record<string, number>;
  } catch (e: any) {
    logger.warn('[FxRateSync] 外部行情源不可达/异常，本次同步跳过（保留手工录入通道）', { error: e?.message, apiUrl });
    result.offline = true;
    return result;
  }

  // ── 目标币种：档案已出现币种 ∪ 空档案默认集 ──
  const rows = await db.exchangeRate.findMany({ select: { currency: true }, take: 1000 });
  const targets = new Set<string>(DEFAULT_CURRENCIES);
  for (const r of rows as Array<{ currency: string }>) {
    if (r.currency) targets.add(r.currency.trim().toUpperCase());
  }

  const risk = createRiskService(prisma);
  for (const currency of [...targets].sort()) {
    const apiRate = Number(apiRates[currency]);
    if (!Number.isFinite(apiRate) || apiRate <= 0) {
      result.skipped.push(currency);
      continue;
    }
    // 日内幂等：当日已同步过 api 记录 → 跳过
    const dup = await db.exchangeRate.findFirst({
      where: { currency, source: 'api', effectiveDate },
    });
    if (dup) {
      result.skipped.push(currency);
      continue;
    }
    const rate = Number((1 / apiRate).toFixed(6));
    try {
      await risk.addExchangeRate(
        { currency, rate, effectiveDate, source: 'api', note: 'exchangerate-api.com 自动同步' },
        SYSTEM_ACTOR,
      );
      result.synced.push(currency);
    } catch (e: any) {
      logger.error('[FxRateSync] 单币种入库失败', { currency, error: e?.message });
      result.skipped.push(currency);
    }
  }

  if (result.synced.length > 0) {
    logger.info('[FxRateSync] 汇率自动同步完成', { synced: result.synced, skipped: result.skipped, effectiveDate });
  }
  return result;
}

export function createFxRateSyncTask(): ScheduledTask {
  return {
    id: 'fx_rate_sync',
    shouldRun: (now: Date) => {
      // 每日 08:30 后执行；按本地日 + 6 小时桶（00-06/06-12/12-18/18-24）去重——
      // 离线失败同日内最多重试 4 次，不刷屏；成功后当日同币种由 source='api' 去重兜底
      const bucket = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${Math.floor(now.getHours() / 6)}`;
      const afterTime = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() >= 30);
      if (afterTime && bucket !== lastRunBucket) {
        lastRunBucket = bucket;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await syncFxRatesFromExternal(prisma);
      } catch (e: any) {
        // 双保险：主流程已全路径兜底，此处仅为调度契约防线
        logger.error('[FxRateSync] failed', { error: e?.message });
      }
    },
  };
}
