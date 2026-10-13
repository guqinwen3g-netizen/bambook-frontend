import { businessNowDate } from '../shared/businessClock';
/**
 * monthlyCloseService.ts — REQ2-17 月末批量结转（DR-058）
 *
 * 设计真源：docs/design/04-模块设计/05-财务与结算/月末批量结转.md
 *
 * DR-058 三决策：
 *   ① 月末时点存量快照：mc:{definitionId}:{periodKey} 幂等键前缀区隔 A5 调度的月初口径
 *      （{id}:{periodKey}）；periodKey 默认上一个完整月；重复结转 skipped（append-only 不覆盖）
 *   ② 对比 = 相邻期 mc: 快照 metric 列（agg(field)）行值求和 → Δ/Δ%
 *      （上期真为 0 → Δ% null 不除零，Δ 算术仍成立；**上期/本期快照缺失 → Δ 为 null**：
 *        没有基线不可计算，绝不回落 0 —— 否则「无快照」被读成「上期 0、环比暴涨」）
 *   ③ 零新表复用 ReportRun 快照真源；审计留痕；单定义失败不阻断其余
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { runReportDefinition } from './reportDefinitionService';

const PERIOD_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type MonthlyCloseResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): MonthlyCloseResult<never> =>
  ({ ok: false, error: { code, message, status } });

/** 上一个完整月的 periodKey（2026-08 任意时点 → 2026-07） */
export function previousMonthKey(now: Date = businessNowDate()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** periodKey 前推一个月 */
export function shiftPeriodKey(periodKey: string, months: -1 | 1): string {
  const [y, m] = periodKey.split('-').map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** mc: 幂等键（月末结转口径，区隔 A5 调度键） */
export function closeIdempotencyKey(definitionId: string, periodKey: string): string {
  return `mc:${definitionId}:${periodKey}`;
}

function assertPeriodKey(periodKey: string): MonthlyCloseResult<never> | null {
  if (!PERIOD_KEY_RE.test(periodKey)) {
    return fail('VALIDATION_FAILED', `periodKey 必须为 YYYY-MM（收到 ${periodKey}）`);
  }
  return null;
}

/** 单条快照的 metric 汇总（metric 列名 = agg(field)，行值求和；count 列求和 = 行数语义） */
function sumMetricTotals(run: any, metrics: Array<{ field: string; agg: string }>): Record<string, number> {
  const totals: Record<string, number> = {};
  const rows = Array.isArray(run?.rows) ? run.rows : [];
  for (const m of metrics) {
    const col = `${m.agg}(${m.field})`;
    let sum = 0;
    for (const row of rows) {
      const v = Number(row?.[col]);
      if (Number.isFinite(v)) sum += v;
    }
    totals[col] = Math.round(sum * 10000) / 10000;
  }
  return totals;
}

export function createMonthlyCloseService(prisma: PrismaClient) {
  const db = prisma as any;

  /**
   * 执行月末结转：遍历 enabled + schedule=monthly 的定义，按 mc: 幂等键批量快照。
   * 重复结转同 periodKey → skipped；单定义失败不阻断其余。
   */
  async function runMonthlyClose(input: { periodKey?: string; actorId?: string; ip?: string | null }): Promise<MonthlyCloseResult<any>> {
    try {
      const periodKey = (input.periodKey ?? previousMonthKey()).trim();
      const invalid = assertPeriodKey(periodKey);
      if (invalid) return invalid;

      const definitions = await db.reportDefinition.findMany({
        where: { deletedAt: null, enabled: true, schedule: 'monthly' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, datasetKey: true },
      });
      if (definitions.length === 0) {
        return fail('NO_MONTHLY_DEFINITIONS', '无可结转的月度报表定义（需存在 enabled 且 schedule=monthly 的定义）', 404);
      }

      const results: any[] = [];
      let ran = 0, skipped = 0, failed = 0;
      for (const def of definitions) {
        const r = await runReportDefinition({
          prisma,
          definitionId: def.id,
          trigger: 'schedule',
          idempotencyKey: closeIdempotencyKey(def.id, periodKey),
        });
        if (r.ok) {
          if (r.data.skipped) {
            skipped++;
            results.push({ definitionId: def.id, name: def.name, datasetKey: def.datasetKey, runId: r.data.run.id, rowCount: r.data.run.rowCount, skipped: true });
          } else {
            ran++;
            results.push({ definitionId: def.id, name: def.name, datasetKey: def.datasetKey, runId: r.data.run.id, rowCount: r.data.run.rowCount, skipped: false });
          }
        } else {
          failed++;
          results.push({ definitionId: def.id, name: def.name, datasetKey: def.datasetKey, skipped: false, error: r.error?.code });
        }
      }

      await writeRouteAuditLog({
        prisma: db,
        actorId: input.actorId || 'system',
        source: 'monthly-close',
        operation: 'monthly_close_execute',
        targetType: 'ReportRun',
        targetId: `mc:${periodKey}`,
        after: { periodKey, total: definitions.length, ran, skipped, failed },
        ip: input.ip ?? null,
        operationType: 'create',
      });

      logger.info('[MonthlyClose] executed', { periodKey, total: definitions.length, ran, skipped, failed });
      return { ok: true, data: { periodKey, total: definitions.length, ran, skipped, failed, results } };
    } catch (e: any) {
      logger.error('[MonthlyClose] run failed', { error: e?.message });
      return fail('INTERNAL_ERROR', e?.message || '结转执行失败', 500);
    }
  }

  /**
   * 月度对比：本期 vs 上期 mc: 快照的 metric 汇总 diff。
   * 上期无快照 → previous=null（提示先结转上月）；periodKey 默认上一个完整月。
   */
  async function compareMonthlyClose(input: { periodKey?: string }): Promise<MonthlyCloseResult<any>> {
    try {
      const periodKey = (input.periodKey ?? previousMonthKey()).trim();
      const invalid = assertPeriodKey(periodKey);
      if (invalid) return invalid;
      const previousPeriodKey = shiftPeriodKey(periodKey, -1);

      const definitions = await db.reportDefinition.findMany({
        where: { deletedAt: null, enabled: true, schedule: 'monthly' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, datasetKey: true, metrics: true },
      });
      if (definitions.length === 0) {
        return fail('NO_MONTHLY_DEFINITIONS', '无可对比的月度报表定义', 404);
      }

      const items: any[] = [];
      for (const def of definitions) {
        const metrics: Array<{ field: string; agg: string }> = Array.isArray(def.metrics) ? def.metrics : [];
        const [currentRun, previousRun] = await Promise.all([
          db.reportRun.findUnique({ where: { idempotencyKey: closeIdempotencyKey(def.id, periodKey) } }),
          db.reportRun.findUnique({ where: { idempotencyKey: closeIdempotencyKey(def.id, previousPeriodKey) } }),
        ]);

        const current = currentRun && currentRun.status === 'Success'
          ? { runId: currentRun.id, rowCount: currentRun.rowCount, totals: sumMetricTotals(currentRun, metrics) }
          : null;
        const previous = previousRun && previousRun.status === 'Success'
          ? { runId: previousRun.id, rowCount: previousRun.rowCount, totals: sumMetricTotals(previousRun, metrics) }
          : null;

        const deltas = metrics.map(m => {
          const col = `${m.agg}(${m.field})`;
          // ★ 空值红线（2026-09-25 修）：原 `?? 0` 把「没有快照」伪装成「上期是 0」
          //   ⇒ Δ = 本期全额，读作「环比暴涨」，而真实语义是「无基线、不可计算」。
          //   顶层 `previous: null`（提示先结转上月）与 deltas 里 `previous: 0` 曾在同一响应内自相矛盾。
          //   判据 = **快照是否存在**（current/previous 是否为 null），而非「合计是否为 0」：
          //   —— 快照存在且汇总真为 0 ⇒ 真零，Δ 算术照旧成立（下方 prev === 0 分支保留）；
          //   —— 快照缺失 ⇒ cur/prev/delta/deltaPct 一律 null，前端渲染为「—」。
          const cur = current == null ? null : (current.totals[col] ?? null);
          const prev = previous == null ? null : (previous.totals[col] ?? null);
          const computable = cur != null && prev != null;
          const delta = computable ? Math.round((cur - prev) * 10000) / 10000 : null;
          return {
            metric: col,
            current: cur,
            previous: prev,
            delta,
            // 上期为 0 → 不除零（无环比基线）；快照缺失 → 同样无基线
            deltaPct: computable && prev !== 0 && delta != null
              ? Math.round((delta / Math.abs(prev)) * 10000) / 100
              : null,
          };
        });

        items.push({ definitionId: def.id, name: def.name, datasetKey: def.datasetKey, current, previous, deltas });
      }

      return { ok: true, data: { periodKey, previousPeriodKey, items } };
    } catch (e: any) {
      logger.error('[MonthlyClose] compare failed', { error: e?.message });
      return fail('INTERNAL_ERROR', e?.message || '月度对比查询失败', 500);
    }
  }

  return { runMonthlyClose, compareMonthlyClose };
}
